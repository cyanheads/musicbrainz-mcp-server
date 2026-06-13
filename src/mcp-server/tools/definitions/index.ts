/**
 * @fileoverview Barrel collecting all MusicBrainz tool definitions into the
 * `allToolDefinitions` array consumed by createApp().
 * @module mcp-server/tools/definitions/index
 */

import { browseEntitiesTool } from './browse-entities.tool.js';
import { getArtistTool } from './get-artist.tool.js';
import { getCoverArtTool } from './get-cover-art.tool.js';
import { getLabelTool } from './get-label.tool.js';
import { getRecordingTool } from './get-recording.tool.js';
import { getReleaseTool } from './get-release.tool.js';
import { getReleaseGroupTool } from './get-release-group.tool.js';
import { getWorkTool } from './get-work.tool.js';
import { lookupIdentifierTool } from './lookup-identifier.tool.js';
import { searchEntitiesTool } from './search-entities.tool.js';

export const allToolDefinitions = [
  searchEntitiesTool,
  getArtistTool,
  getReleaseGroupTool,
  getReleaseTool,
  getRecordingTool,
  getWorkTool,
  getLabelTool,
  lookupIdentifierTool,
  browseEntitiesTool,
  getCoverArtTool,
];
