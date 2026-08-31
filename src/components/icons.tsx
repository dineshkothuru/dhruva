/** One icon vocabulary for the whole app.
 *
 * Emoji were doing this job before: they render differently on every OS, do
 * not inherit currentColor, cannot be optically aligned, and read as a
 * prototype. Every icon now comes from here, so a glyph means the same thing
 * everywhere and size/stroke stay consistent.
 *
 * Sizes: 12 = inline with 11px text, 14 = inline with body, 16 = card header
 * tile, 20 = empty-state. Stroke 1.75 reads sharper than the 2 default at
 * these sizes. */

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ban,
  Globe,
  Monitor,
  CircleDashed,
  CircleSlash,
  CircleX,
  Bot,
  Bug,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDot,
  ClipboardList,
  Columns2,
  Drama,
  Eye,
  FileCode,
  FileText,
  FlaskConical,
  FolderOpen,
  GitCompare,
  Hammer,
  Hand,
  History,
  Info,
  Layers,
  LifeBuoy,
  Lightbulb,
  Link2,
  ListChecks,
  MessageSquare,
  Notebook,
  Package,
  Palette,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Rows2,
  Ruler,
  ScanSearch,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sprout,
  Square,
  Star,
  Terminal,
  TriangleAlert,
  Trash2,
  UserCheck,
  Wrench,
  X,
  Zap,
} from "lucide-react";

export type IconType = typeof Bug;

/** Workflow identities - also used to auto-pick an icon for custom workflows. */
export const WF_ICON = {
  bug: Bug,
  feature: Sparkles,
  design: Ruler,
  ux: Palette,
  build: Hammer,
  test: FlaskConical,
  run: Play,
  sync: RefreshCw,
  preview: Eye,
  validate: ShieldCheck,
  scratch: Sprout,
  deploy: Rocket,
  review: ScanSearch,
  doc: FileText,
  generic: Settings,
} as const;

/** Step roles. */
export const ROLE_ICON = {
  read: Search,
  design: Ruler,
  implement: Hammer,
  review: ScanSearch,
  trace: ListChecks,
} as const;

/** Everything else, named by meaning rather than by picture. */
export const Icon = {
  chat: MessageSquare,
  workflows: Zap,
  setup: Settings,
  editor: FileCode,
  folder: FolderOpen,
  search: Search,
  tool: Wrench,
  output: Package,
  activity: Notebook,
  humanGate: Hand,
  chain: Link2,
  robot: Bot,
  models: SlidersHorizontal,
  history: History,
  inputs: ClipboardList,
  standards: Layers,
  persona: Drama,
  skill: Lightbulb,
  diff: GitCompare,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  split: Columns2,
  inline: Rows2,
  close: X,
  add: Plus,
  remove: Trash2,
  check: Check,
  chevron: ChevronRight,
  ok: CircleCheck,
  warn: TriangleAlert,
  blocked: Ban,
  info: Info,
  running: CircleDot,
  run: Play,
  pending: CircleDashed,
  failed: CircleX,
  skipped: CircleSlash,
  stop: Square,
  resume: RefreshCw,
  star: Star,
  terminal: Terminal,
  monitor: Monitor,
  globe: Globe,
  help: LifeBuoy,
  verified: UserCheck,
} as const;

/** Keyword-matched identity for user-authored workflows, so a custom
 * workflow gets a sensible icon without the author choosing one. */
export function wfIconFor(id: string, title: string): IconType {
  const s = `${id} ${title}`.toLowerCase();
  if (/bug|fix|defect|issue|hotfix/.test(s)) return WF_ICON.bug;
  if (/deploy|release|ship/.test(s)) return WF_ICON.deploy;
  if (/test|coverage|qa\b/.test(s)) return WF_ICON.test;
  if (/review|critique|audit/.test(s)) return WF_ICON.review;
  if (/ux|ui\b|screen|visual|component/.test(s)) return WF_ICON.ux;
  if (/design|architect|spec|erd|hld|tdd/.test(s)) return WF_ICON.design;
  if (/doc|report|summar/.test(s)) return WF_ICON.doc;
  if (/implement|build|develop/.test(s)) return WF_ICON.build;
  if (/sync|retrieve|pull/.test(s)) return WF_ICON.sync;
  if (/org|scratch|sandbox/.test(s)) return WF_ICON.scratch;
  return WF_ICON.generic;
}
