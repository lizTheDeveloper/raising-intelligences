interface MatrixAuth {
  isLoggedIn(): boolean;
  getUserId(): string | null;
  getProfile(userId: string): Promise<{ displayname?: string; avatar_url?: string }>;
  getOpenIdToken(): Promise<{ access_token: string; token_type: string; matrix_server_name: string; expires_in: number }>;
  getJoinedRooms(): Promise<string[]>;
  login(user: string, pass: string): Promise<unknown>;
  logout(): Promise<void>;
  showLoginModal(): void;
}

interface Window {
  matrixAuth?: MatrixAuth;
}
