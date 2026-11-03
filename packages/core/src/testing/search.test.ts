import { MemorySearchIndex, searchIndexContract } from './search';

searchIndexContract('MemorySearchIndex', () => new MemorySearchIndex());
