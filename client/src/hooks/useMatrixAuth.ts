import { useState, useEffect } from "react";

export interface MatrixUser {
  userId: string;
  displayName?: string;
}

async function fetchDisplayName(userId: string): Promise<string | undefined> {
  try {
    const profile = await window.matrixAuth!.getProfile(userId);
    return profile?.displayname ?? undefined;
  } catch {
    return undefined;
  }
}

export function useMatrixAuth() {
  const [user, setUser] = useState<MatrixUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onReady = async (e: Event) => {
      const ce = e as CustomEvent<{ loggedIn: boolean }>;
      setReady(true);
      if (ce.detail.loggedIn && window.matrixAuth?.isLoggedIn()) {
        const userId = window.matrixAuth.getUserId()!;
        setUser({ userId });
        const displayName = await fetchDisplayName(userId);
        if (displayName) setUser({ userId, displayName });
      }
    };

    const onLogin = async (e: Event) => {
      const ce = e as CustomEvent<{ userId: string }>;
      const userId = ce.detail.userId;
      setUser({ userId });
      const displayName = await fetchDisplayName(userId);
      if (displayName) setUser({ userId, displayName });
    };

    const onLogout = () => {
      setUser(null);
    };

    window.addEventListener("matrixAuthReady", onReady);
    window.addEventListener("matrixAuthLogin", onLogin);
    window.addEventListener("matrixAuthLogout", onLogout);

    // Script may have already fired before React mounted
    if (window.matrixAuth?.isLoggedIn()) {
      const userId = window.matrixAuth.getUserId()!;
      setUser({ userId });
      setReady(true);
      fetchDisplayName(userId).then((displayName) => {
        if (displayName) setUser({ userId, displayName });
      });
    }

    return () => {
      window.removeEventListener("matrixAuthReady", onReady);
      window.removeEventListener("matrixAuthLogin", onLogin);
      window.removeEventListener("matrixAuthLogout", onLogout);
    };
  }, []);

  return {
    ready,
    loggedIn: !!user,
    user,
    showLoginModal: () => window.matrixAuth?.showLoginModal(),
    logout: () => window.matrixAuth?.logout(),
  };
}
