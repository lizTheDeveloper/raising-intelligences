interface MatrixAuth {
  isLoggedIn(): boolean;
  getUserId(): string | null;
  showLoginModal(): void;
  logout(): Promise<void>;
}

interface Window {
  matrixAuth?: MatrixAuth;
}
