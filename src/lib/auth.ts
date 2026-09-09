// Who is using the app.
//
// THERE ARE NO ACCOUNTS. This build runs entirely on one machine: every project
// is a file on its disk, every render runs on its GPU or on a key in its own
// keychain, and there is no server to sign in to. The one "identity" the app
// has is the install itself — `localOwnerId()` in localPlane.ts, which is what
// stamps `owner_id` on local rows.
//
// The store keeps the shape the surfaces were written against (`useAuth()` and
// `displayNameOf`), answering "signed in, as this computer" unconditionally,
// so a component that once asked whether it may render simply may.
export interface Profile {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export type AuthStatus = "signed_in";

export interface AuthState {
  status: AuthStatus;
  session: null;
  profile: Profile;
}

const STATE: AuthState = {
  status: "signed_in",
  session: null,
  profile: { id: "local", email: null, display_name: "This computer", avatar_url: null },
};

export function useAuth(): AuthState {
  return STATE;
}

/** Name to show for the user. There is only ever one. */
export function displayNameOf(a: AuthState): string {
  return a.profile.display_name ?? "This computer";
}

/** Whether this session may reach the surfaces that were the studio's own.
 *
 *  Always true. The cloud build had two roles because one account paid for the
 *  render pod and the provider keys, and a member's own project could not be
 *  put on either — so the pod controls, the cost page, the model-visibility
 *  tables and the whole v1 studio were admin-gated. None of those exist here:
 *  the GPU is the one in this machine and the keys are the ones in its
 *  keychain, so there is nobody to withhold anything from.
 *
 *  Kept rather than deleted at ~15 call sites because each of them still reads
 *  as a real question ("may this build show the model map's own filenames?"),
 *  and a fork that grows a second user has one name to change.
 */
export function useIsAdmin(): boolean {
  return true;
}

/** `useIsAdmin`, plus whether the answer is known yet. Never loading here. */
export function useAdminGate(): { isAdmin: boolean; loading: boolean } {
  return { isAdmin: true, loading: false };
}
