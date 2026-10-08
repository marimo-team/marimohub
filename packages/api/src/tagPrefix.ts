import { z } from 'zod';
import { MAX_TAG_PREFIX_LENGTH, PATH_TAG_PATTERN } from '@marimo-hub/core/tag-paths';

export const TagPrefixSchema = z.string().max(MAX_TAG_PREFIX_LENGTH).regex(PATH_TAG_PATTERN);
