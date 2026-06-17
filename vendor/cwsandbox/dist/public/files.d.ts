import type { RequestOptions } from "./common.js";
export type FileContent = string | Uint8Array;
export type FileReadResult = Readonly<Record<string, Uint8Array>>;
export type FileTextReadResult = Readonly<Record<string, string>>;
export type FileWrites = readonly FileWrite[] | Readonly<Record<string, FileContent>>;
export type MountedFileContent = string | Uint8Array;
export type MountedFiles = readonly MountedFile[] | Readonly<Record<string, MountedFileContent>>;
export interface MountedFile {
    readonly content: MountedFileContent;
    readonly path: string;
}
export interface FileWrite {
    readonly content: FileContent;
    readonly path: string;
}
export interface SandboxFiles {
    read(path: string, options?: RequestOptions): Promise<Uint8Array>;
    read(paths: readonly string[], options?: RequestOptions): Promise<FileReadResult>;
    readText(path: string, options?: RequestOptions): Promise<string>;
    readText(paths: readonly string[], options?: RequestOptions): Promise<FileTextReadResult>;
    write(path: string, content: FileContent, options?: RequestOptions): Promise<void>;
    write(files: FileWrites, options?: RequestOptions): Promise<void>;
}
//# sourceMappingURL=files.d.ts.map