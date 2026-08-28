import type { MetaType } from "@/lib/orgMetadata";

/** Metadata types, grouped the way the local tree has folders.
 *
 * describeMetadata returns three hundred-odd type names in one alphabetical
 * run, which puts AIApplicationConfig above ApexClass and buries Flow between
 * FlexiPage and FolderShare. The local tree does not read like that - it has
 * classes, lwc, objects, triggers - so the org side should not either.
 *
 * Grouping is by an explicit table first, then by suffix rules, then "Other".
 * A table is used rather than pure heuristics because the interesting types are
 * a known, finite list and getting THOSE right is what makes the tree usable;
 * the rules exist so a type Salesforce ships next release still lands
 * somewhere sensible instead of vanishing. */

export const GROUP_ORDER = [
  "Apex",
  "Lightning & UI",
  "Data Model",
  "Automation",
  "Security & Access",
  "Reporting",
  "Integration",
  "Experience Cloud",
  "Content",
  "Settings",
  "Other",
] as const;

export type GroupName = (typeof GROUP_ORDER)[number];

const TABLE: Record<string, GroupName> = {
  // Apex
  ApexClass: "Apex",
  ApexTrigger: "Apex",
  ApexPage: "Apex",
  ApexComponent: "Apex",
  ApexTestSuite: "Apex",
  ApexEmailNotifications: "Apex",

  // Lightning & UI
  AuraDefinitionBundle: "Lightning & UI",
  LightningComponentBundle: "Lightning & UI",
  LightningMessageChannel: "Lightning & UI",
  FlexiPage: "Lightning & UI",
  Layout: "Lightning & UI",
  CompactLayout: "Lightning & UI",
  CustomApplication: "Lightning & UI",
  CustomTab: "Lightning & UI",
  AppMenu: "Lightning & UI",
  HomePageLayout: "Lightning & UI",
  HomePageComponent: "Lightning & UI",
  PathAssistant: "Lightning & UI",
  QuickAction: "Lightning & UI",
  GlobalValueSet: "Lightning & UI",
  CustomLabels: "Lightning & UI",
  Translations: "Lightning & UI",
  CustomPageWebLink: "Lightning & UI",
  WebLink: "Lightning & UI",

  // Data Model
  CustomObject: "Data Model",
  CustomField: "Data Model",
  RecordType: "Data Model",
  ValidationRule: "Data Model",
  CustomMetadata: "Data Model",
  CustomObjectTranslation: "Data Model",
  FieldSet: "Data Model",
  ListView: "Data Model",
  Index: "Data Model",
  CustomIndex: "Data Model",
  SharingReason: "Data Model",
  StandardValueSet: "Data Model",
  BusinessProcess: "Data Model",
  MatchingRule: "Data Model",
  MatchingRules: "Data Model",
  DuplicateRule: "Data Model",

  // Automation
  Flow: "Automation",
  FlowDefinition: "Automation",
  FlowCategory: "Automation",
  Workflow: "Automation",
  WorkflowRule: "Automation",
  WorkflowAlert: "Automation",
  WorkflowFieldUpdate: "Automation",
  WorkflowTask: "Automation",
  WorkflowSend: "Automation",
  WorkflowOutboundMessage: "Automation",
  ApprovalProcess: "Automation",
  AssignmentRule: "Automation",
  AssignmentRules: "Automation",
  AutoResponseRule: "Automation",
  AutoResponseRules: "Automation",
  EscalationRule: "Automation",
  EscalationRules: "Automation",
  SharingRules: "Automation",
  PlatformEventSubscriberConfig: "Automation",

  // Security & Access
  Profile: "Security & Access",
  PermissionSet: "Security & Access",
  PermissionSetGroup: "Security & Access",
  MutingPermissionSet: "Security & Access",
  Role: "Security & Access",
  Group: "Security & Access",
  Queue: "Security & Access",
  CustomPermission: "Security & Access",
  SharingRule: "Security & Access",
  SharingCriteriaRule: "Security & Access",
  SharingOwnerRule: "Security & Access",
  SharingSet: "Security & Access",
  Territory: "Security & Access",
  Territory2: "Security & Access",
  Territory2Model: "Security & Access",
  Territory2Rule: "Security & Access",
  Territory2Type: "Security & Access",
  ConnectedApp: "Security & Access",
  AuthProvider: "Security & Access",
  SamlSsoConfig: "Security & Access",
  BlacklistedConsumer: "Security & Access",

  // Reporting
  Report: "Reporting",
  ReportFolder: "Reporting",
  ReportType: "Reporting",
  Dashboard: "Reporting",
  DashboardFolder: "Reporting",
  AnalyticSnapshot: "Reporting",
  AnalyticsDashboard: "Reporting",
  AnalyticsVisualization: "Reporting",
  AnalyticsWorkspace: "Reporting",
  WaveDashboard: "Reporting",
  WaveDataflow: "Reporting",
  WaveDataset: "Reporting",
  WaveLens: "Reporting",
  WaveRecipe: "Reporting",

  // Integration
  NamedCredential: "Integration",
  ExternalCredential: "Integration",
  ExternalDataSource: "Integration",
  ExternalServiceRegistration: "Integration",
  RemoteSiteSetting: "Integration",
  CspTrustedSite: "Integration",
  Certificate: "Integration",
  PlatformEventChannel: "Integration",
  PlatformEventChannelMember: "Integration",
  EventSubscription: "Integration",
  ApiNamedQuery: "Integration",
  CorsWhitelistOrigin: "Integration",

  // Experience Cloud
  Network: "Experience Cloud",
  NetworkBranding: "Experience Cloud",
  Community: "Experience Cloud",
  CommunityTemplateDefinition: "Experience Cloud",
  CommunityThemeDefinition: "Experience Cloud",
  ExperienceBundle: "Experience Cloud",
  ExperiencePropertyTypeBundle: "Experience Cloud",
  SiteDotCom: "Experience Cloud",
  CustomSite: "Experience Cloud",
  Audience: "Experience Cloud",
  BrandingSet: "Experience Cloud",
  ManagedTopics: "Experience Cloud",
  NavigationMenu: "Experience Cloud",

  // Content
  StaticResource: "Content",
  Document: "Content",
  DocumentFolder: "Content",
  ContentAsset: "Content",
  EmailTemplate: "Content",
  EmailFolder: "Content",
  Letterhead: "Content",
  Portal: "Content",
  Scontrol: "Content",
};

/** Suffix and prefix rules for anything the table does not name. Order matters:
 * the first match wins, so the most specific rules come first. */
const RULES: { test: RegExp; group: GroupName }[] = [
  { test: /Settings$/, group: "Settings" },
  { test: /^Wave|^Analytic/, group: "Reporting" },
  { test: /^Territory/, group: "Security & Access" },
  { test: /Sharing/, group: "Security & Access" },
  { test: /^Apex/, group: "Apex" },
  { test: /^Lightning|^Aura|^Flexi|Layout$|^Custom(Tab|Application)/, group: "Lightning & UI" },
  { test: /^Flow|^Workflow|Rule$|Rules$/, group: "Automation" },
  { test: /^Community|^Network|^Experience|^Site/, group: "Experience Cloud" },
  { test: /^Email|^Document|^Content/, group: "Content" },
  { test: /^Platform(Event|Cache)|^External|Credential$/, group: "Integration" },
  { test: /^Custom(Object|Field|Metadata)|^Record(Type)|^Standard/, group: "Data Model" },
];

export function groupFor(typeName: string): GroupName {
  const exact = TABLE[typeName];
  if (exact) return exact;
  for (const r of RULES) if (r.test.test(typeName)) return r.group;
  return "Other";
}

export interface TypeGroup {
  name: GroupName;
  types: MetaType[];
}

/** Types split into the groups above, in GROUP_ORDER, with empty groups
 * dropped so an org that has no Experience Cloud shows no such folder. */
export function groupTypes(types: MetaType[]): TypeGroup[] {
  const buckets = new Map<GroupName, MetaType[]>();
  for (const t of types) {
    const g = groupFor(t.name);
    const list = buckets.get(g) ?? [];
    list.push(t);
    buckets.set(g, list);
  }
  return GROUP_ORDER.filter((g) => (buckets.get(g)?.length ?? 0) > 0).map((g) => ({
    name: g,
    types: (buckets.get(g) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** Groups worth opening on arrival - where the work usually is. Everything
 * else starts collapsed, which is the point of grouping in the first place. */
export const OPEN_BY_DEFAULT: GroupName[] = ["Apex", "Lightning & UI", "Data Model"];
