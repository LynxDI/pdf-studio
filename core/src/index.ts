// @pdf-studio/core — public surface.
//
// The OpenPDF Workflow (OPW) engine: model, the validate → optimize → compile
// pipeline, the pluggable renderer-adapter execution layer, dependency probing,
// and content hashing. Zero vscode imports — consumed by the extension, the MCP
// server, and (later) a cloud runner from this single entrypoint.

export const VERSION = "0.1.0";

// --- OPW model + IO ---
export {
  OPW_VERSION,
  type Workflow,
  type OpNode,
  type OutputSpec,
  type DocumentKind,
} from "./opw/model.js";
export {
  parseWorkflow,
  serializeWorkflow,
  serializeWorkflowJson,
  serializeFlowParams,
  parseFlowValue,
  normalizeOperations,
  OpwParseError,
} from "./opw/io.js";

// --- Operation registry (the DSL vocabulary) ---
export {
  OPERATIONS,
  OP_ALIASES,
  lookupOperation,
  creatorForExtension,
  opChangesPagination,
  effectiveParams,
  type Capability,
  type OperationSpec,
  type ParamSpec,
  type ParamType,
} from "./opw/operations.js";
export { OP_DOCS, OP_CATEGORIES, SEARCH_KEYWORDS, type OpDoc, type OpCategory } from "./opw/op-docs.js";
export { renderOpDoc, renderOpReference, buildExampleWorkflow, opSearchIndex } from "./opw/op-render.js";
export { insertOperation, insertOperationAt, pageSafeInsertIndex, removeOperationAt } from "./opw/text-edit.js";
export { checkPageListSyntax, expandPageIndices, expandPageList } from "./opw/pages.js";

// --- PDF form-fill: form-pack registry + record resolver + catalog ---
export {
  FORM_SCHEMAS,
  getFormSchema,
  listForms,
  formCategories,
  formFillExampleYaml,
  resolveFormFill,
  buildRoles,
  renderFormDoc,
  blankPeople,
  validatePack,
  fieldTargets,
  extractFormValues,
  detectForm,
  toTable,
  toCsv,
  groupByForm,
  csvToRecords,
  parseCsv,
  VOCAB,
  isVocabKey,
  type RawField,
  type ExtractedForm,
  type FormMatch,
  type FormSchema,
  type FormField,
  type FormCategory,
  type FillResolution,
  type FillInstruction,
  type ResolveInput,
  type RecordMap,
} from "./forms/index.js";

// --- Pipeline stages: Validator → Optimizer → Compile → Diff ---
export {
  validateWorkflow,
  hasErrors,
  type Diagnostic,
  type Severity,
} from "./opw/validate.js";
export { optimizeWorkflow, type OptimizeResult, type Rewrite } from "./opw/optimize.js";
export { resolveVars, SECRET_PARAMS, type VarValue, type ResolveResult } from "./opw/vars.js";
export { evaluateWhen, analyzeWhen, KNOWN_FACTS, WhenError, type WhenScope, type WhenAnalysis } from "./opw/when.js";
export {
  compileWorkflow,
  describePlan,
  type ExecutionPlan,
  type PlanStep,
  type UnsatisfiedStep,
  type CompileOptions,
} from "./opw/compile.js";
export {
  diffWorkflows,
  stableStringify,
  type WorkflowChange,
  type ChangeKind,
} from "./opw/diff.js";

// --- Execution layer: adapters + registry + executor ---
export {
  AdapterRegistry,
  type RendererAdapter,
  type ExecContext,
  type AdapterResult,
  type EmittedArtifact,
} from "./adapters/adapter.js";
export { PdfLibAdapter } from "./adapters/pdflib/index.js";
export { PythonAdapter, type PythonAdapterOptions } from "./adapters/python/index.js";
export { CliCompressAdapter } from "./adapters/cli/index.js";
export { CliOfficeAdapter } from "./adapters/office/index.js";
export { CliVideoAdapter } from "./adapters/video/index.js";
export {
  capabilityRegistry,
  PDFLIB_CAPABILITIES,
  PYTHON_CAPABILITIES,
  OFFICE_CAPABILITIES,
  VIDEO_CAPABILITIES,
} from "./adapters/capabilities.js";
export {
  runWorkflow,
  runWorkflowText,
  defaultRegistry,
  nodeFs,
  type HostFs,
  type RunWorkflowOptions,
  type RunWorkflowResult,
} from "./execute.js";

// --- Dependency probing (color-coded sidebar) ---
export {
  checkDependencies,
  installCommand,
  envWithToolPath,
  toolAugmentedPath,
  DEPENDENCY_TIERS,
  type DependencyStatus,
  type DependencyState,
  type DependencyTier,
  type CheckDependenciesOptions,
} from "./deps/check.js";
export {
  resolvePythonWithPyMuPDF,
  resolvePythonWithMarkitdown,
  resetPythonResolution,
  parseLastJsonObject,
  type PythonCmd,
} from "./deps/python-resolve.js";

// --- PDF introspection (Document object tree) ---
export {
  inspectPdf,
  type PdfInfo,
  type PdfPageInfo,
  type PdfMetadata,
} from "./opw/inspect.js";

// --- Hashing + errors ---
export { sha256Hex, workflowContentKey } from "./hashing.js";
export { ValidationError, UnsatisfiedCapabilityError, MissingFileError } from "./errors.js";
