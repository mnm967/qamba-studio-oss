// What the person at the keyboard may do in the project on screen.
//
// Everything: a project on this machine has exactly one participant. The hook
// keeps the shape the surfaces were written against (the cloud build had
// owners, editors and viewers), so nothing that reads `canEdit` had to change.
export type ProjectRole = "owner";

export interface RoleState {
  role: ProjectRole | null;
  loading: boolean;
  canEdit: boolean;
  isOwner: boolean;
  /** Shared with me, rather than mine. Never, here. */
  isShared: boolean;
}

const OWNER: RoleState = {
  role: "owner", loading: false, canEdit: true, isOwner: true, isShared: false,
};

const NONE: RoleState = {
  role: null, loading: false, canEdit: false, isOwner: false, isShared: false,
};

export function useProjectRole(projectId: string | null | undefined): RoleState {
  return projectId ? OWNER : NONE;
}
