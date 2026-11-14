export type Node = { path: string; name: string; children?: Node[] }
export type Disk = { content: string; hash: string }
export type Save = { conflict: true; disk: Disk | null } | { conflict: false; disk: Disk }
export type Mode = 'split' | 'source'
export type Draft = { text: string; base: string | null }
export type Session = {
  tabs: { path: string; draft?: Draft }[]
  active?: string
  mode: Mode | 'read'
  recent?: string[]
  favorites?: string[]
}
export type SearchResult = { path: string; title: string; excerpt: string }
export type Workspace = { token: string; name: string; nodes: Node[]; session: Session | null }

declare global {
  interface Window {
    notes: {
      choose(): Promise<Workspace | null>
      resume(): Promise<Workspace | null>
      session(scope: string, session: Session): Promise<void>
      search(scope: string, query: string): Promise<SearchResult[]>
      tree(scope: string): Promise<Node[]>
      read(scope: string, path: string): Promise<Disk | null>
      info(scope: string, content: string): Promise<{ title: string; tags: string[] }>
      updateInfo(scope: string, content: string, title: string, tags: string[]): Promise<string>
      save(scope: string, path: string, content: string, base: string | null, overwrite?: boolean): Promise<Save>
      create(scope: string, dir: string, name: string, folder: boolean): Promise<string>
      move(scope: string, path: string, dir: string, name: string): Promise<string>
      trash(scope: string, path: string): Promise<void>
      paste(scope: string, path: string): Promise<string>
      onChanged(listener: (change: { token: string; error?: string }) => void): () => void
    }
  }
}
