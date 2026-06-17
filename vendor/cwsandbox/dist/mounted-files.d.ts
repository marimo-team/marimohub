import type { FileContent, FileWrite, FileWrites, MountedFile, MountedFiles } from "./types.js";
export declare function normalizeMountedFiles(mountedFiles: MountedFiles | undefined): readonly MountedFile[];
export declare function normalizeFileContent(content: FileContent): Uint8Array;
export declare function normalizeFileWrites(files: FileWrites): readonly FileWrite[];
export declare function validateFileWrites(files: FileWrites): void;
export declare function validateReadPaths(paths: readonly string[]): void;
export declare function validateMountedFiles(mountedFiles: MountedFiles | undefined): void;
export declare function validateAbsolutePath(path: string, fieldName: string): void;
//# sourceMappingURL=mounted-files.d.ts.map