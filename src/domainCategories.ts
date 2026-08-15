import { invoke } from "@tauri-apps/api/core";
import type { Category } from "./types";

export async function listWorkspaceCategories(): Promise<Category[]> {
  return invoke("list_workspace_categories");
}

export async function createWorkspaceCategory(name: string): Promise<Category> {
  return invoke("create_workspace_category", { params: { name } });
}

export async function updateWorkspaceCategory(
  id: number,
  name: string,
): Promise<Category> {
  return invoke("update_workspace_category", { params: { id, name } });
}

export async function deleteWorkspaceCategory(id: number): Promise<void> {
  await invoke("delete_workspace_category", { id });
}

export async function listCommandCategories(): Promise<Category[]> {
  return invoke("list_command_categories");
}

export async function createCommandCategory(name: string): Promise<Category> {
  return invoke("create_command_category", { params: { name } });
}

export async function updateCommandCategory(
  id: number,
  name: string,
): Promise<Category> {
  return invoke("update_command_category", { params: { id, name } });
}

export async function deleteCommandCategory(id: number): Promise<void> {
  await invoke("delete_command_category", { id });
}
