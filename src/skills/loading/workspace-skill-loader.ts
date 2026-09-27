import { canonicalizePath } from "../../agents/utils/paths.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import {
  captureSkillLibrarySelection,
  loadSkillLibrarySelection,
  prepareSkillLibrarySelection,
} from "../library/selection.js";
import { getSkillsSourceVersion, observeSkillsSnapshotSource } from "../runtime/refresh-state.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { readBundledSkillEntries } from "./bundled-skill-loader.js";
import { hasBinary, prepareSkillBinaryProbe } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";
import { createSkillEntry } from "./skill-entry-metadata.js";
import { createSkillLoadDiagnostics, type SkillLoadDiagnostics } from "./skill-load-diagnostics.js";
import { resolvePluginSkillsDir, resolveSkillsUserHomeDir } from "./skill-paths.js";
import {
  appendLowerPrecedenceSkillRecords,
  mergeSkillRecords,
  reportSkillPrecedenceCollisions,
  type SkillCollision,
} from "./skill-precedence.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import {
  loadGeneratedPluginSkillRecords,
  loadSkillRootRecords,
  type LoadedSkillRecord,
} from "./skill-root-loader.js";
import {
  filterSkillEntries,
  resolveEffectiveWorkspaceSkillFilter,
} from "./workspace-skill-filter.js";
import {
  normalizeWorkspaceSkillRoots,
  resolveWorkspaceSkillDirectories,
} from "./workspace-skill-roots.js";
import {
  resolveCustodianSkillAgentId,
  resolveWorkspaceSkillSourcePlan,
  splitSkillSourcePlan,
  type WorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
  type WorkspaceSkillSources,
} from "./workspace-skill-sources.js";

const MAX_SKILL_ENTRY_CACHE_SIZE = 64;
type LocalSkillTiers = {
  sourceKey: string;
  agent: SkillEntry[];
  execution: SkillEntry[];
  collisions: SkillCollision[];
  diagnostics: SkillLoadDiagnostics;
};
const skillEntryCache = new Map<string, LocalSkillTiers>();
const agentSkillEntryCache = new Map<
  string,
  Pick<LocalSkillTiers, "agent" | "collisions" | "diagnostics">
>();
const pluginMetadataIds = new WeakMap<PluginMetadataSnapshot, number>();
let nextPluginMetadataId = 0;

type WorkspaceSkillLoadOptions = {
  bundledSkillName?: string;
  executionWorkspaceDir?: string;
  librarySelections?: SkillSnapshot["librarySelections"];
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  agentId?: string;
  /**
   * "ignore" keeps agentId scoping source discovery (custodian skills) without
   * activating the agent allowlist filter — status/inventory views need the
   * full entry list so excluded skills stay present-but-marked.
   */
  agentSkillFilter?: "apply" | "ignore";
  eligibility?: SkillEligibilityContext;
  workspaceOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

type LocalWorkspaceSkillLoadOptions = WorkspaceSkillLoadOptions & {
  /** Local menu discovery must not depend on a remote workspace being available. */
  gatewayOnly?: boolean;
};

/** Scan selected roots on their owning host, retaining native precedence and file rules. */
function loadWorkspaceSkillSourceEntries(
  plan: WorkspaceSkillSourcePlan,
  diagnostics: ReturnType<typeof createSkillLoadDiagnostics>,
  config?: OpenClawConfig,
  collisions?: SkillCollision[],
): WorkspaceSkillSources["entries"] {
  const grouped = new Map<string, Array<LoadedSkillRecord & { sourceOrder?: number }>>();
  for (const root of plan.roots) {
    const records = grouped.get(root.tier) ?? [];
    for (const record of loadSkillRootRecords({ ...root, config, diagnostics })) {
      records.push(Object.assign({}, record, { sourceOrder: root.order }));
    }
    grouped.set(root.tier, records);
  }
  const extra = grouped.get("extra") ?? [];
  if (plan.pluginSkillsDir) {
    for (const record of loadGeneratedPluginSkillRecords({
      pluginSkillsDir: plan.pluginSkillsDir,
      pluginSkillRoots: plan.pluginSkillRoots,
      source: "openclaw-extra",
      limits: resolveSkillDiscoveryLimits(config),
      diagnostics,
    })) {
      extra.push(
        Object.assign({}, record, {
          sourceOrder:
            (plan.roots.find((root) => root.tier !== "extra")?.order ??
              Math.max(-1, ...plan.roots.map((root) => root.order ?? -1)) + 1) - 0.5,
        }),
      );
    }
  }
  grouped.set("extra", extra);
  // Custodian and bundled records share a tier and deterministic collision order.
  grouped
    .get("bundled")
    ?.sort(
      (left, right) =>
        left.skill.name.localeCompare(right.skill.name, "en") ||
        left.skill.source.localeCompare(right.skill.source, "en"),
    );
  return mergeSkillRecords(
    ["extra", "bundled", "workshop", "managed", "personal", "workspace"].flatMap(
      (tier) => grouped.get(tier) ?? [],
    ),
    JSON.stringify(["sources", plan.workspaceDir]),
    collisions,
  ).map(createSkillEntry);
}

function loadExecutionSkillEntries(
  executionWorkspaceDir: string,
  diagnostics: ReturnType<typeof createSkillLoadDiagnostics>,
  config?: OpenClawConfig,
  collisions?: SkillCollision[],
): SkillEntry[] {
  return mergeSkillRecords(
    resolveWorkspaceSkillDirectories(executionWorkspaceDir).flatMap((root) =>
      loadSkillRootRecords({ ...root, config, diagnostics }),
    ),
    JSON.stringify(["execution", executionWorkspaceDir]),
    collisions,
  ).map(createSkillEntry);
}

/** Run on the workspace host using an admitted source plan and native discovery limits. */
export function readWorkspaceSkillSources(
  request: WorkspaceSkillSourceRequest,
): WorkspaceSkillSources {
  const diagnostics = createSkillLoadDiagnostics();
  const config: OpenClawConfig = {
    skills: {
      limits: request.limits,
      load: { allowSymlinkTargets: request.sourcePlan.allowSymlinkTargets },
    },
  };
  const entries =
    request.bundledSkillName !== undefined
      ? readBundledSkillEntries(request.bundledSkillName, diagnostics, {
          config,
          bundledSkillsDir: request.sourcePlan.bundledSkillsDir,
        })
      : loadWorkspaceSkillSourceEntries(request.sourcePlan, diagnostics, config);
  const executionEntries = request.executionWorkspaceDir
    ? loadExecutionSkillEntries(request.executionWorkspaceDir, diagnostics, config)
    : [];
  const bins = [
    ...new Set([
      "brew",
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "uv",
      "go",
      ...request.additionalBins,
      ...entries
        .concat(executionEntries)
        .flatMap((entry) =>
          (entry.metadata?.requires?.bins ?? []).concat(entry.metadata?.requires?.anyBins ?? []),
        ),
    ]),
  ]
    .filter(hasBinary)
    .toSorted();
  return {
    entries,
    executionEntries,
    diagnostics: diagnostics.snapshot(),
    runtime: { platform: process.platform, bins },
    ...(request.status
      ? {
          status: readWorkspaceSkillStatusFacts({
            entries,
            workspaceDir: request.sourcePlan.workspaceDir,
            managedSkillsDir: request.sourcePlan.managedSkillsDir,
            skillCardKey: request.status.skillCardKey,
          }),
        }
      : {}),
  };
}

function loadLocalSkillTiers(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
): LocalSkillTiers {
  const workspaceOnly = opts?.workspaceOnly === true;
  const { executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const custodianAgentId = resolveCustodianSkillAgentId(opts?.config, opts?.agentId, workspaceOnly);
  const metadata = opts?.pluginMetadataSnapshot;
  let metadataId = metadata && pluginMetadataIds.get(metadata);
  if (metadata && metadataId === undefined) {
    metadataId = ++nextPluginMetadataId;
    pluginMetadataIds.set(metadata, metadataId);
  }
  // Source revisions invalidate discovery even when resolved content stays unchanged.
  const agentSourceKey = JSON.stringify([
    workspaceDir,
    workspaceOnly,
    opts?.gatewayOnly,
    opts?.agentId ? normalizeAgentId(opts.agentId) : undefined,
    custodianAgentId,
    opts?.managedSkillsDir,
    opts?.bundledSkillsDir,
    opts?.pluginSkillsDir ?? resolvePluginSkillsDir(),
    resolveSkillsUserHomeDir(),
    process.env.OPENCLAW_STATE_DIR,
  ]);
  const agentCacheKey = JSON.stringify([
    agentSourceKey,
    opts?.config ? fingerprintSkillSnapshotConfig(opts.config) : undefined,
    metadataId,
    getSkillsSourceVersion(workspaceDir),
  ]);
  const sourceKey = JSON.stringify([agentSourceKey, executionWorkspaceDir]);
  const cacheKey = JSON.stringify([
    agentCacheKey,
    executionWorkspaceDir,
    getSkillsSourceVersion(workspaceDir, opts),
  ]);
  const cachedEntries = skillEntryCache.get(cacheKey);
  if (cachedEntries) {
    return cachedEntries;
  }

  let agentTier = agentSkillEntryCache.get(agentCacheKey);
  if (!agentTier) {
    const plan = resolveWorkspaceSkillSourcePlan(workspaceDir, opts);
    const collisions: SkillCollision[] = [];
    const diagnostics = createSkillLoadDiagnostics();
    agentTier = {
      agent: loadWorkspaceSkillSourceEntries(
        opts?.gatewayOnly ? splitSkillSourcePlan(plan).gatewayPlan : plan,
        diagnostics,
        opts?.config,
        collisions,
      ),
      collisions,
      diagnostics: diagnostics.snapshot(),
    };
    agentSkillEntryCache.set(agentCacheKey, agentTier);
    pruneMapToMaxSize(agentSkillEntryCache, MAX_SKILL_ENTRY_CACHE_SIZE);
  }
  const collisions = [...agentTier.collisions];
  const diagnostics = createSkillLoadDiagnostics();
  diagnostics.merge(agentTier.diagnostics);
  const entries = {
    sourceKey,
    collisions,
    agent: agentTier.agent,
    execution:
      executionWorkspaceDir && !workspaceOnly && !opts?.gatewayOnly
        ? loadExecutionSkillEntries(executionWorkspaceDir, diagnostics, opts?.config, collisions)
        : [],
    diagnostics: diagnostics.snapshot(),
  };
  skillEntryCache.set(cacheKey, entries);
  pruneMapToMaxSize(skillEntryCache, MAX_SKILL_ENTRY_CACHE_SIZE);
  const winners = appendLowerPrecedenceSkillRecords(
    [...entries.agent],
    entries.execution,
    (winner, loser) => {
      if (canonicalizePath(winner.skill.filePath) !== canonicalizePath(loser.skill.filePath)) {
        collisions.push({ winner: winner.skill, loser: loser.skill });
      }
    },
  );
  // Retain only discovery inputs, never the turn's assertions, eligibility, or session state.
  const sourceOptions: LocalWorkspaceSkillLoadOptions = {
    executionWorkspaceDir,
    workspaceOnly,
    gatewayOnly: opts?.gatewayOnly,
    agentId: opts?.agentId,
    config: opts?.config,
    managedSkillsDir: opts?.managedSkillsDir,
    bundledSkillsDir: opts?.bundledSkillsDir,
    pluginSkillsDir: opts?.pluginSkillsDir,
    pluginMetadataSnapshot: opts?.pluginMetadataSnapshot,
  };
  observeSkillsSnapshotSource({
    workspaceDir,
    sourceKey,
    sourceScope: sourceOptions,
    entries: winners
      .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
      .map((entry) => ({ skill: entry.skill, skillKey: resolveSkillKey(entry.skill, entry) })),
    reconcile: (inputs) => {
      if (inputs) {
        sourceOptions.config = inputs.config;
        sourceOptions.pluginMetadataSnapshot = inputs.pluginMetadataSnapshot;
      }
      return loadLocalSkillTiers(workspaceDir, sourceOptions).sourceKey;
    },
    suspend: () => {
      sourceOptions.config = undefined;
      sourceOptions.pluginMetadataSnapshot = undefined;
    },
  });
  return entries;
}

function mergeSkillTiers(
  tiers: LocalSkillTiers,
  opts?: LocalWorkspaceSkillLoadOptions,
  libraryEntries = opts?.librarySelections?.length
    ? loadSkillLibrarySelection(opts.librarySelections)
    : [],
): SkillEntry[] {
  const entries = mergeRemoteNodeSkillEntries(tiers.agent, opts?.eligibility?.nodeSkills);
  const collisions = [...tiers.collisions];
  if (tiers.execution.length > 0) {
    const localNames = new Set(tiers.agent.map((entry) => entry.skill.name));
    // Include node skills in the agent tier before admitting execution-local names.
    // Agent entries also stay first when the prompt budget truncates the catalog.
    appendLowerPrecedenceSkillRecords(entries, tiers.execution, (winner, loser) => {
      if (!localNames.has(loser.skill.name)) {
        collisions.push({ winner: winner.skill, loser: loser.skill });
      }
    });
  }
  reportSkillPrecedenceCollisions(collisions, tiers.sourceKey);
  entries.push(...libraryEntries);
  return entries;
}

/** Keep Library pins and physical read authority fixed across workspace discovery retries. */
function captureWorkspaceSkillPreparation(
  workspaceDir: string,
  opts: (WorkspaceSkillLoadOptions & { entries?: SkillEntry[] }) | undefined,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  const needsLibrary =
    opts?.bundledSkillName === undefined &&
    (opts?.entries === undefined ||
      Boolean(getAgentWorkspaceAccess(workspaceDir, "loadSkills")?.loadSkills));
  const librarySelections = captureSkillLibrarySelection(
    needsLibrary ? (opts?.librarySelections ?? []) : [],
  );
  const libraryContext = librarySelections.length ? captureOpenClawStateWorkerContext() : undefined;
  return {
    librarySelections,
    libraryContext,
    assertCurrent: () => {
      assertCurrent?.();
      libraryContext?.maintenanceScope?.assertAdmission();
      libraryContext?.admission.assertCurrent();
    },
  };
}

async function prepareCapturedWorkspaceSkillEntries(
  workspaceDir: string,
  opts: Parameters<typeof prepareWorkspaceSkillEntries>[1],
  preparation: ReturnType<typeof captureWorkspaceSkillPreparation>,
): Promise<{
  entries: SkillEntry[];
  diagnostics: SkillLoadDiagnostics;
  runtime?: WorkspaceSkillSources["runtime"];
  status?: WorkspaceSkillSources["status"];
}> {
  const { assertCurrent, libraryContext, librarySelections } = preparation;
  assertCurrent();
  const access = getAgentWorkspaceAccess(workspaceDir, "loadSkills");
  if (!access?.loadSkills && opts?.bundledSkillName !== undefined) {
    const diagnostics = createSkillLoadDiagnostics();
    const entries = readBundledSkillEntries(opts.bundledSkillName, diagnostics, opts);
    return { entries, diagnostics: diagnostics.snapshot() };
  }
  if (!access?.loadSkills && opts?.entries !== undefined) {
    return { entries: opts.entries, diagnostics: opts.diagnostics ?? { items: [], omitted: 0 } };
  }
  const libraryEntries = libraryContext
    ? await prepareSkillLibrarySelection(
        librarySelections,
        { env: libraryContext.environment },
        assertCurrent,
      )
    : [];
  assertCurrent();
  if (!access?.loadSkills) {
    const tiers = loadLocalSkillTiers(workspaceDir, opts);
    return {
      entries: mergeSkillTiers(tiers, opts, libraryEntries),
      diagnostics: tiers.diagnostics,
    };
  }
  const bundledOnly = opts?.bundledSkillName !== undefined;
  const { agentWorkspaceDir, executionWorkspaceDir } = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  const { gatewayPlan, workspacePlan } = splitSkillSourcePlan(
    resolveWorkspaceSkillSourcePlan(agentWorkspaceDir, opts),
  );
  const diagnostics = createSkillLoadDiagnostics();
  const gatewaySourceEntries = bundledOnly
    ? readBundledSkillEntries(opts.bundledSkillName!, diagnostics, opts)
    : loadWorkspaceSkillSourceEntries(gatewayPlan, diagnostics, opts?.config);
  const gatewayEntries: SkillEntry[] = [];
  for (const entry of gatewaySourceEntries) {
    gatewayEntries.push({ ...entry, skill: { ...entry.skill, fileHost: "gateway" } });
  }
  const sources = await access.loadSkills({
    sourcePlan: bundledOnly ? { ...workspacePlan, roots: [] } : workspacePlan,
    executionWorkspaceDir: opts?.workspaceOnly || bundledOnly ? undefined : executionWorkspaceDir,
    limits: resolveSkillDiscoveryLimits(opts?.config),
    additionalBins: [
      ...new Set(
        libraryEntries
          .concat(gatewayEntries)
          .concat(opts?.entries ?? [])
          .flatMap((entry) =>
            (entry.metadata?.requires?.bins ?? []).concat(entry.metadata?.requires?.anyBins ?? []),
          ),
      ),
    ],
    status: opts?.status,
  });
  assertCurrent();
  // A host-supplied source label or path must never authorize Gateway-local reads.
  diagnostics.merge(sources.diagnostics);
  const diagnosticSnapshot = diagnostics.snapshot();
  const onWorkspace = (entry: WorkspaceSkillSources["entries"][number]) => ({
    ...entry,
    skill: { ...entry.skill, fileHost: "workspace" as const },
  });
  const hostEntries = sources.entries.map(onWorkspace);
  // The order is discovery provenance, not permission to read Gateway files.
  const agentEntries = mergeSkillRecords(
    [...gatewayEntries, ...hostEntries].toSorted((left, right) => {
      const order = (entry: WorkspaceSkillSources["entries"][number]) =>
        entry.sourceOrder ??
        Math.max(
          -1,
          ...workspacePlan.roots
            .filter((root) => root.source === entry.skill.source)
            .map((root) => root.order ?? -1),
        );
      return order(left) - order(right);
    }),
    JSON.stringify(["remote-agent", agentWorkspaceDir]),
  );
  return {
    entries: bundledOnly
      ? gatewayEntries
      : (opts?.entries ??
        mergeSkillTiers(
          {
            sourceKey: JSON.stringify(["remote", agentWorkspaceDir, executionWorkspaceDir]),
            agent: agentEntries,
            execution: sources.executionEntries.map(onWorkspace),
            collisions: [],
            diagnostics: diagnosticSnapshot,
          },
          opts,
          libraryEntries,
        )),
    diagnostics: diagnosticSnapshot,
    runtime: sources.runtime,
    status: sources.status,
  };
}

/** Acquire host source tiers before the native node/execution/Library merge. */
export async function prepareWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions & {
    entries?: SkillEntry[];
    diagnostics?: SkillLoadDiagnostics;
    status?: { skillCardKey?: string };
  },
  assertCurrent?: () => void,
): Promise<{
  entries: SkillEntry[];
  diagnostics: SkillLoadDiagnostics;
  runtime?: WorkspaceSkillSources["runtime"];
  status?: WorkspaceSkillSources["status"];
}> {
  const preparation = captureWorkspaceSkillPreparation(workspaceDir, opts, assertCurrent);
  const sources = await prepareCapturedWorkspaceSkillEntries(workspaceDir, opts, preparation);
  preparation.assertCurrent();
  return sources;
}

export async function resolveWorkspaceSkillPromptEntries(
  workspaceDir: string,
  opts?: {
    executionWorkspaceDir?: string;
    librarySelections?: SkillSnapshot["librarySelections"];
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    agentId?: string;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    eligibility?: SkillEligibilityContext;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    assertCurrent?: () => void;
  },
): Promise<{ eligible: SkillEntry[]; skillFilter: string[] | undefined }> {
  const { entries, skillFilter } = await prepareWorkspaceSkillSelection(
    workspaceDir,
    opts,
    "prompt",
    opts?.assertCurrent,
  );
  return { eligible: entries, skillFilter };
}

async function prepareWorkspaceSkillSelection(
  workspaceDir: string,
  opts: Parameters<typeof prepareWorkspaceSkillEntries>[1],
  mode: "prompt" | "runtime",
  assertCurrent?: () => void,
): Promise<{ entries: SkillEntry[]; skillFilter: string[] | undefined }> {
  const preparation = captureWorkspaceSkillPreparation(workspaceDir, opts, assertCurrent);
  for (;;) {
    preparation.assertCurrent();
    const sourceVersion = getSkillsSourceVersion(workspaceDir, opts);
    let skillFilter = mode === "prompt" ? resolveEffectiveWorkspaceSkillFilter(opts) : undefined;
    const sources = await prepareCapturedWorkspaceSkillEntries(workspaceDir, opts, preparation);
    preparation.assertCurrent();
    const entries = sources.entries;
    if (mode === "runtime") {
      const selection = resolveWorkspaceSkillLoad(workspaceDir, opts, sources);
      skillFilter = selection.effectiveSkillFilter;
      if (!selection.shouldFilter) {
        return { entries, skillFilter };
      }
    }
    const probe = await prepareSkillBinaryProbe(
      entries,
      { ...opts, skillFilter },
      preparation.assertCurrent,
      sources.runtime,
    );
    preparation.assertCurrent();
    if (
      probe.needsRetry() ||
      ((mode === "runtime" || !opts?.entries) &&
        getSkillsSourceVersion(workspaceDir, opts) !== sourceVersion)
    ) {
      continue;
    }
    const eligible = filterSkillEntries(
      entries,
      opts?.config,
      skillFilter,
      opts?.skillOverrides,
      opts?.eligibility,
      probe.hasBin,
      sources.runtime?.platform,
    );
    preparation.assertCurrent();
    if (probe.needsRetry()) {
      continue;
    }
    return { entries: eligible, skillFilter };
  }
}

function resolveWorkspaceSkillLoad(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
  prepared?: { entries: SkillEntry[]; diagnostics: SkillLoadDiagnostics },
) {
  const roots = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: workspaceDir,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
  });
  let discovery = prepared;
  if (!discovery) {
    const tiers = loadLocalSkillTiers(roots.agentWorkspaceDir, opts);
    discovery = { entries: mergeSkillTiers(tiers, opts), diagnostics: tiers.diagnostics };
  }
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return {
    ...discovery,
    effectiveSkillFilter,
    shouldFilter:
      Boolean(roots.executionWorkspaceDir) ||
      effectiveSkillFilter !== undefined ||
      opts?.skillOverrides !== undefined ||
      opts?.eligibility !== undefined,
  };
}

/** Runtime preparation shares discovery and filtering with synchronous SDK inventory reads. */
export async function prepareWorkspaceSkills(
  workspaceDir: string,
  opts?: WorkspaceSkillLoadOptions,
  assertCurrent?: () => void,
): Promise<SkillEntry[]> {
  return (await prepareWorkspaceSkillSelection(workspaceDir, opts, "runtime", assertCurrent))
    .entries;
}

/** Reads entries and failures from the same cached discovery, before status rendering. */
export function loadWorkspaceSkillDiscovery(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
): { entries: SkillEntry[]; diagnostics: SkillLoadDiagnostics } {
  const { entries, diagnostics, effectiveSkillFilter, shouldFilter } = resolveWorkspaceSkillLoad(
    workspaceDir,
    opts,
  );
  return {
    entries: shouldFilter
      ? filterSkillEntries(
          entries,
          opts?.config,
          effectiveSkillFilter,
          opts?.skillOverrides,
          opts?.eligibility,
        )
      : entries,
    diagnostics,
  };
}

export function loadWorkspaceSkills(
  workspaceDir: string,
  opts?: LocalWorkspaceSkillLoadOptions,
): SkillEntry[] {
  return loadWorkspaceSkillDiscovery(workspaceDir, opts).entries;
}

export function loadVisibleSkills(
  workspaceDir: string,
  opts?: {
    gatewayOnly?: boolean;
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    librarySelections?: SkillSnapshot["librarySelections"];
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    agentId?: string;
    agentSkillFilter?: "apply" | "ignore";
    eligibility?: SkillEligibilityContext;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
): SkillEntry[] {
  const entries = mergeSkillTiers(loadLocalSkillTiers(workspaceDir, opts), opts);
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return filterSkillEntries(
    entries,
    opts?.config,
    effectiveSkillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}

export function filterWorkspaceSkills(
  entries: SkillEntry[],
  opts?: {
    config?: OpenClawConfig;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  return filterSkillEntries(
    entries,
    opts?.config,
    opts?.skillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}
