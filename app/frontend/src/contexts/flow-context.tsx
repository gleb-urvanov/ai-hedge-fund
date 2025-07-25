import { getMultiNodeDefinition, isMultiNodeComponent } from '@/data/multi-node-mappings';
import { getNodeTypeDefinition } from '@/data/node-mappings';
import { flowConnectionManager } from '@/hooks/use-flow-connection';
import { clearAllNodeStates, getAllNodeStates, setNodeInternalState, setCurrentFlowId as setNodeStateFlowId } from '@/hooks/use-node-state';
import { flowService } from '@/services/flow-service';
import { Flow } from '@/types/flow';
import { MarkerType, ReactFlowInstance, useReactFlow, XYPosition } from '@xyflow/react';
import { createContext, ReactNode, useCallback, useContext, useState } from 'react';

interface FlowContextType {
  addComponentToFlow: (componentName: string) => Promise<void>;
  saveCurrentFlow: (name?: string, description?: string) => Promise<Flow | null>;
  loadFlow: (flow: Flow) => Promise<void>;
  createNewFlow: () => Promise<void>;
  currentFlowId: number | null;
  currentFlowName: string;
  isUnsaved: boolean;
  reactFlowInstance: ReactFlowInstance;
}

const FlowContext = createContext<FlowContextType | null>(null);

export function useFlowContext() {
  const context = useContext(FlowContext);
  if (!context) {
    throw new Error('useFlowContext must be used within a FlowProvider');
  }
  return context;
}

interface FlowProviderProps {
  children: ReactNode;
}

export function FlowProvider({ children }: FlowProviderProps) {
  const reactFlowInstance = useReactFlow();
  const [currentFlowId, setCurrentFlowId] = useState<number | null>(null);
  const [currentFlowName, setCurrentFlowName] = useState('Untitled Flow');
  const [isUnsaved, setIsUnsaved] = useState(false);

  // Calculate viewport center position with optional randomness
  const getViewportPosition = useCallback((addRandomness = false): XYPosition => {
    let position: XYPosition = { x: 0, y: 0 }; // Default position
    
    try {
      const { zoom, x, y } = reactFlowInstance.getViewport();
      
      // Get the React Flow container dimensions instead of window dimensions
      const flowContainer = document.querySelector('.react-flow__viewport')?.parentElement;
      const containerWidth = flowContainer?.clientWidth || window.innerWidth;
      const containerHeight = flowContainer?.clientHeight || window.innerHeight;
      
      position = {
        x: (containerWidth / 2 - x) / zoom,
        y: (containerHeight / 2 - y) / zoom,
      };
    } catch (err) {
      console.warn('Could not get viewport', err);
    }
    
    if (addRandomness) {
      position.x += Math.random() * 300;
      position.y = 0;
    }
    
    return position;
  }, [reactFlowInstance]);

  // Mark flow as unsaved when changes are made
  const markAsUnsaved = useCallback(() => {
    setIsUnsaved(true);
  }, []);

  // Save current flow
  const saveCurrentFlow = useCallback(async (name?: string, description?: string): Promise<Flow | null> => {
    try {
      const nodes = reactFlowInstance.getNodes();
      const edges = reactFlowInstance.getEdges();
      const viewport = reactFlowInstance.getViewport();
      
      // Collect all node internal states (from use-node-state)
      const nodeStates = getAllNodeStates();
      const nodeInternalStates = Object.fromEntries(nodeStates);

      // Create structured data - nodeContextData will be added by enhanced save functions
      const data = {
        nodeStates: nodeInternalStates,  // use-node-state data
        // nodeContextData will be added separately by enhanced save functions
      };

      if (currentFlowId) {
        // Update existing flow
        const updatedFlow = await flowService.updateFlow(currentFlowId, {
          name: name || currentFlowName,
          description,
          nodes,
          edges,
          viewport,
          data,
        });
        setCurrentFlowName(updatedFlow.name);
        setIsUnsaved(false);
        // Remember this flow as the last selected
        localStorage.setItem('lastSelectedFlowId', updatedFlow.id.toString());
        // Ensure the flow ID is set for node state isolation
        setNodeStateFlowId(updatedFlow.id.toString());
        return updatedFlow;
      } else {
        // Create new flow
        const newFlow = await flowService.createFlow({
          name: name || currentFlowName,
          description,
          nodes,
          edges,
          viewport,
          data,
        });
        setCurrentFlowId(newFlow.id);
        setCurrentFlowName(newFlow.name);
        setIsUnsaved(false);
        // Remember this flow as the last selected
        localStorage.setItem('lastSelectedFlowId', newFlow.id.toString());
        // Set the flow ID for node state isolation
        setNodeStateFlowId(newFlow.id.toString());
        return newFlow;
      }
    } catch (error) {
      console.error('Failed to save flow:', error);
      return null;
    }
  }, [reactFlowInstance, currentFlowId, currentFlowName]);

  // Load a flow
  const loadFlow = useCallback(async (flow: Flow) => {
    try {
      // CRITICAL: Set the current flow ID FIRST, before rendering nodes
      // This ensures useNodeState hooks initialize with the correct flow ID
      setNodeStateFlowId(flow.id.toString());
      setCurrentFlowId(flow.id);
      setCurrentFlowName(flow.name);
      
      // DO NOT clear configuration state when loading flows - useNodeState handles flow isolation automatically
      // Only restore additional internal states if they exist in the flow data
      if (flow.data) {
        // Handle backward compatibility - data might be direct nodeStates or structured data
        const dataToRestore = flow.data.nodeStates || flow.data;
        
        if (dataToRestore) {
          Object.entries(dataToRestore).forEach(([nodeId, nodeState]) => {
            setNodeInternalState(nodeId, nodeState as Record<string, any>);
          });
        }
        
        // nodeContextData restoration will be handled by enhanced load functions
      }
      
      // Now render the nodes - useNodeState hooks will initialize with correct flow ID
      reactFlowInstance.setNodes(flow.nodes || []);
      reactFlowInstance.setEdges(flow.edges || []);
      
      if (flow.viewport) {
        reactFlowInstance.setViewport(flow.viewport);
      } else {
        // Fit view if no viewport data
        setTimeout(() => {
          reactFlowInstance.fitView();
        }, 100);
      }

      setIsUnsaved(false);
      
      // Remember this flow as the last selected
      localStorage.setItem('lastSelectedFlowId', flow.id.toString());

      // IMPORTANT: Allow components to mount first, then recover connection state
      // This ensures useFlowConnection hooks are initialized before recovery
      setTimeout(() => {
        // Check if this flow has any stale processing states and recover them
        const connection = flowConnectionManager.getConnection(flow.id.toString());
        if (connection.state === 'idle') {
          // No active connection, so any IN_PROGRESS states are stale and should be reset
          console.log(`Flow ${flow.id} loaded - checking for stale connection states`);
        }
      }, 100);
    } catch (error) {
      console.error('Failed to load flow:', error);
    }
  }, [reactFlowInstance]);

  // Create a new flow
  const createNewFlow = useCallback(async () => {
    try {
      // CRITICAL: Reset flow ID FIRST, before clearing nodes
      setNodeStateFlowId(null);
      setCurrentFlowId(null);
      setCurrentFlowName('Untitled Flow');
      
      // Clear all node states for the current flow
      clearAllNodeStates();
      
      // Clear the React Flow canvas
      reactFlowInstance.setNodes([]);
      reactFlowInstance.setEdges([]);
      reactFlowInstance.setViewport({ x: 0, y: 0, zoom: 1 });

      setIsUnsaved(false);

      // Clear any active connections when creating a new flow
      // Note: We don't have a current flow ID to clear, so this is mainly cleanup
      console.log('Created new flow - any previous connections should be cleaned up');
    } catch (error) {
      console.error('Failed to create new flow:', error);
    }
  }, [reactFlowInstance]);

  // Add a single node to the flow
  const addSingleNodeToFlow = useCallback(async (componentName: string) => {
    try {
      const nodeTypeDefinition = await getNodeTypeDefinition(componentName);
      if (!nodeTypeDefinition) {
        console.warn(`No node type definition found for component: ${componentName}`);
        return;
      }

      const position = getViewportPosition(false);
      const newNode = nodeTypeDefinition.createNode(position);
      reactFlowInstance.setNodes((nodes) => [...nodes, newNode]);
      markAsUnsaved();
    } catch (error) {
      console.error(`Failed to add component ${componentName} to flow:`, error);
    }
  }, [reactFlowInstance, getViewportPosition, markAsUnsaved]);

  // Add a multi node (group of nodes with edges) to the flow
  const addMultipleNodesToFlow = useCallback(async (name: string) => {
    try {
      const multiNodeDefinition = getMultiNodeDefinition(name);
      if (!multiNodeDefinition) {
        console.warn(`No multi node definition found for: ${name}`);
        return;
      }

      const basePosition = getViewportPosition();

      // Calculate bounding box of all nodes to center the group
      const nodePositions = multiNodeDefinition.nodes.map(node => ({
        x: node.offsetX,
        y: node.offsetY
      }));
      
      const minX = Math.min(...nodePositions.map(pos => pos.x));
      const maxX = Math.max(...nodePositions.map(pos => pos.x));
      const minY = Math.min(...nodePositions.map(pos => pos.y));
      const maxY = Math.max(...nodePositions.map(pos => pos.y));
      
      // Center the group by adjusting base position
      const groupCenterX = (minX + maxX) / 2;
      const groupCenterY = (minY + maxY) / 2;
      
      const adjustedBasePosition = {
        x: basePosition.x - groupCenterX,
        y: basePosition.y - groupCenterY,
      };

      // Create nodes (async)
      const newNodes = await Promise.all(
        multiNodeDefinition.nodes.map(async (nodeConfig) => {
          try {
            const nodeTypeDefinition = await getNodeTypeDefinition(nodeConfig.componentName);
            if (!nodeTypeDefinition) {
              console.warn(`No node type definition found for: ${nodeConfig.componentName}`);
              return null;
            }

            const position = {
              x: adjustedBasePosition.x + nodeConfig.offsetX,
              y: adjustedBasePosition.y + nodeConfig.offsetY,
            };

            return nodeTypeDefinition.createNode(position);
          } catch (error) {
            console.error(`Failed to create node for ${nodeConfig.componentName}:`, error);
            return null;
          }
        })
      );
      
      const validNodes = newNodes.filter((node): node is NonNullable<typeof node> => node !== null);

      // Create a mapping from component names to actual node IDs
      const componentNameToNodeId = new Map<string, string>();
      multiNodeDefinition.nodes.forEach((nodeConfig, index) => {
        const correspondingNode = validNodes[index];
        if (correspondingNode) {
          componentNameToNodeId.set(nodeConfig.componentName, correspondingNode.id);
        }
      });

      // Create edges using the actual node IDs
      const newEdges = multiNodeDefinition.edges.map((edgeConfig) => {
        const sourceNodeId = componentNameToNodeId.get(edgeConfig.source);
        const targetNodeId = componentNameToNodeId.get(edgeConfig.target);
        
        if (!sourceNodeId || !targetNodeId) {
          console.warn(`Could not resolve node IDs for edge: ${edgeConfig.source} -> ${edgeConfig.target}`);
          return null;
        }
        
        return {
          id: `${sourceNodeId}-${targetNodeId}`,
          source: sourceNodeId,
          target: targetNodeId,
          markerEnd: {
            type: MarkerType.ArrowClosed,
          },
        };
      }).filter((edge): edge is NonNullable<typeof edge> => edge !== null);

      // Add nodes and edges to flow
      reactFlowInstance.setNodes((nodes) => [...nodes, ...validNodes]);
      reactFlowInstance.setEdges((edges) => [...edges, ...newEdges]);
      markAsUnsaved();
      
      // Fit view to show all nodes after a short delay to ensure nodes are rendered
      setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.1, duration: 500 });
      }, 100);
    } catch (error) {
      console.error(`Failed to add multi-node component ${name} to flow:`, error);
    }
  }, [reactFlowInstance, getViewportPosition, markAsUnsaved]);

  // Main entry point - route to single node or multi node
  const addComponentToFlow = useCallback(async (componentName: string) => {
    if (isMultiNodeComponent(componentName)) {
      await addMultipleNodesToFlow(componentName);
    } else {
      await addSingleNodeToFlow(componentName);
    }
  }, [addMultipleNodesToFlow, addSingleNodeToFlow]);

  const value = {
    addComponentToFlow,
    saveCurrentFlow,
    loadFlow,
    createNewFlow,
    currentFlowId,
    currentFlowName,
    isUnsaved,
    reactFlowInstance,
  };

  return (
    <FlowContext.Provider value={value}>
      {children}
    </FlowContext.Provider>
  );
} 