import { invoke } from "@tauri-apps/api/core";

export interface SavedCommandRow {
  id: number;
  title: string;
  body: string;
  sortOrder: number;
  updatedAt: number;
}

export async function listSavedCommands(): Promise<SavedCommandRow[]> {
  return invoke("list_commands");
}

export async function saveCommandRow(params: {
  title: string;
  body: string;
}): Promise<SavedCommandRow> {
  return invoke("save_command", { params });
}

export async function updateCommandRow(params: {
  id: number;
  title: string;
  body: string;
}): Promise<SavedCommandRow> {
  return invoke("update_command", { params });
}

export async function deleteCommandRow(id: number): Promise<void> {
  await invoke("delete_command", { id });
}

/** 执行时若末尾无换行则补一个，便于 shell 立刻运行 */
export function commandTextForInject(body: string, run: boolean): string {
  if (!run) return body;
  return body.endsWith("\n") ? body : `${body}\n`;
}
