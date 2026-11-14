export type Node = { path: string; name: string; children?: Node[]; attachment?: boolean }
export type Disk = { content: string; hash: string; identity?: string }
export type Save = { conflict: true; disk: Disk | null } | { conflict: false; disk: Disk }
export type TrashPreview = { directory: boolean; files: number; directories: number; signature: string }
export type Mode = 'split' | 'source'
export type Draft = { text: string; base: string | null; baseline?: string | null; identity?: string; checkedAt?: string }
export type Session = {
  tabs: { path: string; draft?: Draft }[]
  active?: string
  mode: Mode | 'read'
  recent?: string[]
  favorites?: string[]
}
export type SearchField = 'title' | 'path' | 'body'
export type SearchResult = { path: string; title: string; excerpt: string; fields: SearchField[] }
export type WorkspaceIssue = { kind: 'read' | 'index' | 'yaml' | 'link' | 'asset' | 'draft'; path?: string; detail: string }
export type Jump = { line: number; match?: string }
export type Workspace = { token: string; name: string; nodes: Node[]; session: Session | null }

declare global {
  interface Window {
    notes: {
      choose(): Promise<Workspace | null>
      resume(): Promise<Workspace | null>
      session(scope: string, session: Session): Promise<{ path: string; checkedAt: string }[]>
      search(scope: string, query: string): Promise<SearchResult[]>
      rebuildIndex(scope: string): Promise<{ total: number; backup?: string }>
      checkWorkspace(scope: string, drafts: string[]): Promise<WorkspaceIssue[]>
      tree(scope: string): Promise<Node[]>
      read(scope: string, path: string): Promise<Disk | null>
      movedNote(scope: string, path: string, identity: string, hash: string): Promise<string | null>
      copyCode(scope: string, text: string): Promise<void>
      openExternal(scope: string, url: string): Promise<void>
      info(scope: string, content: string): Promise<{ title: string; tags: string[] }>
      updateInfo(scope: string, content: string, title: string, tags: string[]): Promise<string>
      save(scope: string, path: string, content: string, base: string | null, overwrite?: boolean, exact?: boolean): Promise<Save>
      create(scope: string, dir: string, name: string, folder: boolean): Promise<string>
      move(scope: string, path: string, dir: string, name: string, blocked: { path: string; text: string }[]): Promise<string>
      trashPreview(scope: string, path: string): Promise<TrashPreview>
      trash(scope: string, path: string, signature: string): Promise<TrashPreview | null>
      paste(scope: string, path: string): Promise<string>
      onChanged(listener: (change: { token: string; error?: string }) => void): () => void
    }
  }
}
