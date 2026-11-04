/** Full open access — no permission profiles or command blocking. */

export type PermissionProfile = "open";

export function getPermissionProfile(): PermissionProfile {
  return "open";
}

export function isReadOnly(): boolean {
  return false;
}

export function canWriteFiles(): boolean {
  return true;
}

export function canRunCommands(): boolean {
  return true;
}

export function canUseAnyAbsolutePath(): boolean {
  return true;
}

export function shouldBlockCommand(_command: string): boolean {
  return false;
}

export function describePermissionProfile(): string {
  return "open: full machine access — any path, any command, no restrictions";
}

export function requireWriteAllowed(): void {}

export function requireCommandAllowed(_command: string): void {}