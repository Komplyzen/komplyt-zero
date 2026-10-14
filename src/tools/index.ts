import { ToolRegistry, ToolHandler, ToolName } from '../contracts.js';
import { nodeCreateTool } from './node-create.js';
import { nodeUpdateTool } from './node-update.js';
import { queryTool } from './query.js';
import { relateTool } from './relate.js';
import { sessionStartTool } from './session-start.js';
import { sessionEndTool } from './session-end.js';
import { sessionInfoTool } from './session-info.js';
import { metaModelTool } from './meta-model.js';
import { statusTool } from './status.js';

const tools: ToolHandler[] = [
  nodeCreateTool,
  nodeUpdateTool,
  queryTool,
  relateTool,
  sessionStartTool,
  sessionEndTool,
  sessionInfoTool,
  statusTool,
  metaModelTool,
];

export const toolRegistry: ToolRegistry = {
  list: () => tools,
  get: (name: ToolName) => tools.find(t => t.name === name),
};

export {
  nodeCreateTool,
  nodeUpdateTool,
  queryTool,
  relateTool,
  sessionStartTool,
  sessionEndTool,
  sessionInfoTool,
  statusTool,
  metaModelTool,
};
