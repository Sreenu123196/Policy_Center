// Thrown when someone tries something their roles do not allow. The API layer (step H1) turns it into a "forbidden" answer.
export class PermissionError extends Error {
  readonly permission: string;

  constructor(permission: string) {
    super(`You do not have the permission ${permission}`);
    this.name = 'PermissionError';
    this.permission = permission;
  }
}
