// Undo/redo via the command pattern. A command is a batch of voxel edits
// (one brush stroke = one command), each recording the previous material so
// it can be inverted. The whole history serializes to JSON — that's what
// the native .dream format will embed.

import type { World } from "./world";

export interface VoxelEdit {
  x: number;
  y: number;
  z: number;
  prev: number;
  next: number;
}

export class History {
  private undoStack: VoxelEdit[][] = [];
  private redoStack: VoxelEdit[][] = [];

  /** Apply a batch of edits to the world and record it as one undoable command. */
  apply(world: World, edits: { x: number; y: number; z: number; mat: number }[]): VoxelEdit[] {
    const recorded: VoxelEdit[] = [];
    for (const e of edits) {
      const prev = world.set(e.x, e.y, e.z, e.mat);
      if (prev !== e.mat) recorded.push({ x: e.x, y: e.y, z: e.z, prev, next: e.mat });
    }
    if (recorded.length > 0) {
      this.undoStack.push(recorded);
      this.redoStack.length = 0;
    }
    return recorded;
  }

  undo(world: World): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    for (let i = cmd.length - 1; i >= 0; i--) {
      const e = cmd[i]!;
      world.set(e.x, e.y, e.z, e.prev);
    }
    this.redoStack.push(cmd);
    return true;
  }

  redo(world: World): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    for (const e of cmd) world.set(e.x, e.y, e.z, e.next);
    this.undoStack.push(cmd);
    return true;
  }

  get depth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  serialize(): string {
    return JSON.stringify({ undo: this.undoStack, redo: this.redoStack });
  }

  static deserialize(json: string): History {
    const h = new History();
    const data = JSON.parse(json) as { undo: VoxelEdit[][]; redo: VoxelEdit[][] };
    h.undoStack = data.undo;
    h.redoStack = data.redo;
    return h;
  }
}
