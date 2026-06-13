/**
 * @fileoverview Barrel collecting all MusicBrainz resource definitions into the
 * `allResourceDefinitions` array consumed by createApp().
 * @module mcp-server/resources/definitions/index
 */

import { entityResource } from './entity.resource.js';

export const allResourceDefinitions = [entityResource];
