/** Result of attaching a project folder. This shape is the seam for future
 * phases: it becomes the Project context handed to agent adapters. */

export type ProjectStatus = "connected" | "not_salesforce" | "not_found";

export interface PackageDir {
  path: string;
  default: boolean;
}

export interface OrgStatus {
  connected: boolean;
  username?: string;
  instanceUrl?: string;
  /** Why the org check did not succeed (no default org, sf CLI missing, timeout…). */
  reason?: string;
}

export interface DetectionResult {
  status: ProjectStatus;
  /** Human-readable hint when status is not "connected". */
  message?: string;
  /** Absolute path that was checked (normalized). */
  path: string;
  projectName?: string;
  sourceApiVersion?: string;
  packageDirectories?: PackageDir[];
  isGitRepo?: boolean;
  org?: OrgStatus;
  /** Set on "not_salesforce" when the folder has no files - safe to scaffold. */
  isEmptyFolder?: boolean;
}
