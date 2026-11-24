/**
 * DEV ONLY: a stand-in for /matrix-auth.js for the local host-tools harness.
 *
 * Imported from main.tsx behind `import.meta.env.DEV`, so production builds
 * drop it (and this file) entirely. With `?devmxid=@name:local` in the URL, or
 * a remembered `ri_dev_mxid`, `window.matrixAuth` signs in as that id and its
 * OpenID token is the string "dev:@name:local", which a local server started
 * with RI_DEV_FAKE_MATRIX=true accepts (server/src/dev/harness.ts).
 * `?devmxid=` with no value forgets it.
 */

export const DEV_MXID_KEY = "ri_dev_mxid";

/** Same shape the server's harness accepts. */
const DEV_MXID = /^@[a-z0-9._=-]+:[a-z0-9.-]+$/;

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/**
 * Which dev Matrix id to sign in as: the URL's `devmxid` (remembered), else the
 * remembered one. Invalid ids are ignored. Returns null for "no shim".
 */
export function resolveDevMxid(search: string, store: KV | null): string | null {
  const fromUrl = new URLSearchParams(search).get("devmxid");
  if (fromUrl !== null) {
    const id = fromUrl.trim().toLowerCase();
    try {
      if (DEV_MXID.test(id)) store?.setItem(DEV_MXID_KEY, id);
      else store?.removeItem(DEV_MXID_KEY);
    } catch { /* blocked storage */ }
    return DEV_MXID.test(id) ? id : null;
  }
  try {
    const saved = store?.getItem(DEV_MXID_KEY) ?? null;
    return saved && DEV_MXID.test(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** The fake client: same interface as matrix-auth.d.ts. */
export function devMatrixAuth(mxid: string, onLogout: () => void): MatrixAuth {
  let loggedIn = true;
  return {
    isLoggedIn: () => loggedIn,
    getUserId: () => (loggedIn ? mxid : null),
    getProfile: async () => ({ displayname: mxid.slice(1).split(":")[0] }),
    getOpenIdToken: async () => ({ access_token: `dev:${mxid}`, token_type: "Bearer", matrix_server_name: mxid.split(":")[1] ?? "local", expires_in: 3600 }),
    getJoinedRooms: async () => [],
    login: async () => { loggedIn = true; },
    logout: async () => { loggedIn = false; onLogout(); },
    showLoginModal: () => {
      // eslint-disable-next-line no-console
      console.info(`[dev] Matrix shim: signed in as ${mxid}. add ?devmxid=@someone:local to switch, ?devmxid= to stop.`);
    },
  };
}

/** Installs the shim (overriding any real script) when a dev id is set. */
export function installDevMatrixShim(win: Window): void {
  let store: KV | null = null;
  try { store = win.localStorage; } catch { /* blocked */ }
  const mxid = resolveDevMxid(win.location.search, store);
  // Tidy the address bar: the id is remembered now.
  const url = new URL(win.location.href);
  if (url.searchParams.has("devmxid")) {
    url.searchParams.delete("devmxid");
    const q = url.searchParams.toString();
    win.history.replaceState(win.history.state, "", `${url.pathname}${q ? `?${q}` : ""}${url.hash}`);
  }
  if (!mxid) return;
  win.matrixAuth = devMatrixAuth(mxid, () => {
    try { store?.removeItem(DEV_MXID_KEY); } catch { /* blocked */ }
    win.dispatchEvent(new CustomEvent("matrixAuthLogout"));
  });
  // eslint-disable-next-line no-console
  console.warn(`[dev] Matrix shim active: ${mxid} (OpenID token "dev:${mxid}")`);
  win.dispatchEvent(new CustomEvent("matrixAuthReady", { detail: { loggedIn: true } }));
  win.dispatchEvent(new CustomEvent("matrixAuthLogin", { detail: { userId: mxid } }));
}
