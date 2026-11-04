import type { Ticket } from "../shared/desk.ts";

export interface Config {
  users: string[];
  memento_key: string;
  vola_key: string;
}

/** The backend's routes. Every write says who is doing it in `X-User-Id`. */
async function request<T>(method: string, path: string, user: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "x-user-id": user, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = await response.json();
  if (!response.ok) throw new Error(answer.error ?? `${method} ${path}: ${response.status}`);
  return answer;
}

export const getConfig = () => request<Config>("GET", "/config", "");

export const getTicket = (id: string, user: string) =>
  request<Ticket>("GET", `/tickets/${id}`, user);

export const createTicket = (user: string, title: string, body: string) =>
  request<Ticket>("POST", "/tickets", user, { title, body });

export const setStatus = (id: string, user: string, status: string) =>
  request<Ticket>("PATCH", `/tickets/${id}/status`, user, { status });

export const assign = (id: string, user: string, assignee: string) =>
  request<Ticket>("POST", `/tickets/${id}/assign`, user, { assignee });

export const comment = (id: string, user: string, text: string) =>
  request("POST", `/tickets/${id}/comments`, user, { text });

export const fileAttached = (id: string, user: string, fileId: string) =>
  request("POST", `/tickets/${id}/files`, user, { file_id: fileId });
