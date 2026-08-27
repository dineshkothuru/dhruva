import path from "node:path";
import { promises as fs } from "node:fs";

/** Per-PROJECT settings - <project>/.dhruva/settings.json. Today: the UX
 * design configuration. When ux.enabled is set, Solution design runs its
 * conditional UX steps with these rules injected as (hidden, audited) run
 * inputs; when off, those steps are skipped and nothing changes. */

export interface ProjectSettings {
  ux?: {
    enabled: boolean;
    /** Standing design-inputs folder (style guides, conventions). */
    designDir: string;
    /** The team's specific UX rules, injected into the ux-design prompt. */
    rules: string;
  };
}

function file(root: string) {
  return path.join(root, ".dhruva", "settings.json");
}

export async function readProjectSettings(root: string): Promise<ProjectSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(file(root), "utf8")) as ProjectSettings;
    if (!raw || typeof raw !== "object") return {};
    const out: ProjectSettings = {};
    if (raw.ux && typeof raw.ux === "object") {
      out.ux = {
        enabled: raw.ux.enabled === true,
        designDir:
          typeof raw.ux.designDir === "string" && !raw.ux.designDir.includes("..")
            ? raw.ux.designDir.slice(0, 200)
            : "docs/design",
        rules: typeof raw.ux.rules === "string" ? raw.ux.rules.slice(0, 4000) : "",
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeProjectSettings(root: string, s: ProjectSettings): Promise<void> {
  await fs.mkdir(path.dirname(file(root)), { recursive: true });
  await fs.writeFile(file(root), JSON.stringify(s, null, 2) + "\n", "utf8");
}
