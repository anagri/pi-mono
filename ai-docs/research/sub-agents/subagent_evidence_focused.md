
## Aider-AI__aider
### 11 aider/models.py
22: from aider.openrouter import OpenRouterModelManager
154: class ModelInfoManager:
169: # Manager for the cached OpenRouter model database
170: self.openrouter_manager = OpenRouterModelManager()
174: if hasattr(self, "openrouter_manager"):
175: self.openrouter_manager.set_verify_ssl(verify_ssl)
258: openrouter_info = self.openrouter_manager.get_model_info(model)
319: model_info_manager = ModelInfoManager()
### 4 tests/basic/test_model_info_manager.py
7: from aider.models import ModelInfoManager
10: class TestModelInfoManager(TestCase):
13: self.manager = ModelInfoManager()
16: self.manager.cache_dir = Path(self.temp_dir.name)
17: self.manager.cache_file = self.manager.cache_dir / "model_prices_and_context_window.json"
18: self.manager.cache_dir.mkdir(exist_ok=True)
34: self.manager._update_cache()
35: mock_get.assert_called_with(self.manager.MODEL_INFO_URL, timeout=5, verify=True)
### 2 tests/basic/test_openrouter.py
3: from aider.models import ModelInfoManager
4: from aider.openrouter import OpenRouterModelManager
20: OpenRouterModelManager should return correct metadata taken from the
38: manager = OpenRouterModelManager()
39: info = manager.get_model_info("openrouter/mistralai/mistral-medium-3")
47: def test_model_info_manager_uses_openrouter_manager(monkeypatch):
49: ModelInfoManager should delegate to OpenRouterModelManager when litellm
64: # Force OpenRouterModelManager to return our stub info
### 2 aider/repo.py
39: @contextlib.contextmanager
297: # Use context managers to handle environment variables
### 2 aider/main.py
526: # Set verify_ssl on the model_info_manager
527: models.model_info_manager.set_verify_ssl(False)
### 2 aider/analytics.py
13: from aider.models import model_info_manager
199: info = model_info_manager.get_model_from_cached_json_db(model.name)
### 1 aider/waiting.py
198: # Allow use as a context-manager
### 1 aider/openrouter.py
29: class OpenRouterModelManager:
### 1 aider/coders/context_prompts.py
41: - AlarmManager class for setup/teardown of alarms
### -3 tests/basic/test_ssl_verification.py
23: @patch("aider.models.ModelInfoManager.set_verify_ssl")
28: def test_no_verify_ssl_flag_sets_model_info_manager(
60: # Verify model_info_manager.set_verify_ssl was called with False
71: @patch("aider.models.model_info_manager.set_verify_ssl")
80: # Verify model_info_manager.set_verify_ssl was not called

## FoundationAgents__MetaGPT
### 36 metagpt/memory/role_zero_memory.py
11: from metagpt.const import TEAMLEADER_NAME
79: self._transfer_to_longterm_memory()
119: def _transfer_to_longterm_memory(self):
190: """Checks if the last message is from a user requirement or sent by the team leader."""
199: sent_from_team_leader = message.sent_from == TEAMLEADER_NAME
201: return is_user_message and (cause_by_user_requirement or sent_from_team_leader)
### 28 tests/metagpt/memory/test_role_zero_memory.py
6: from metagpt.const import TEAMLEADER_NAME
20: mock_memory._transfer_to_longterm_memory = mocker.Mock()
26: mock_memory._transfer_to_longterm_memory.assert_called_once()
69: def test_transfer_to_longterm_memory(self, mocker, mock_memory: RoleZeroLongTermMemory):
74: mock_memory._transfer_to_longterm_memory()
113: (UserMessage(content="test", sent_from=TEAMLEADER_NAME), True),
### 24 metagpt/team.py
6: @File    : team.py
32: class Team(BaseModel):
34: Team: Possesses one or more roles (agents), SOP (Standard Operating Procedures), and a env for instant messaging,
46: super(Team, self).__init__(**data)
60: stg_path = SERDESER_PATH.joinpath("team") if stg_path is None else stg_path
61: team_info_path = stg_path.joinpath("team.json")
65: write_json_file(team_info_path, serialized_data)
68: def deserialize(cls, stg_path: Path, context: Context = None) -> "Team":
### 24 metagpt/roles/di/team_leader.py
8: from metagpt.const import TEAMLEADER_NAME
10: from metagpt.prompts.di.team_leader import (
22: @register_tool(include_functions=["publish_team_message"])
23: class TeamLeader(RoleZero):
24: name: str = TEAMLEADER_NAME
25: profile: str = "Team Leader"
26: goal: str = "Manage a team to assist users"
28: # TeamLeader only reacts once each time, but may encounter errors or need to ask human, thus allowing 2 more turns
### 24 metagpt/prompts/di/team_leader.py
4: You are a team leader, and you are responsible for drafting tasks and routing tasks to your team members.
5: Your team member:
6: {team_info}
7: You should NOT assign consecutive tasks to the same team member, instead, assign an aggregated task (or the complete requirement) and let the team member to decompose it.
8: When drafting and routing tasks, ALWAYS include necessary or important info inside the instruction, such as path, link, environment to team members, because you are their sole info source.
11: If plan is created, you should track the progress based on team member feedback message, and update plan accordingly, such as Plan.finish_current_task, Plan.reset_task, Plan.replace_task, etc.
12: You should use TeamLeader.publish_team_message to team members, asking them to start their task. DONT omit any necessary info such as path, link, environment, programming language, framework, requirement, constraint from
13: Pay close attention to new user message, review the conversation history, use RoleZero.reply_to_human to respond to the user directly, DON'T ask your team members.
### 16 tests/metagpt/serialize_deserialize/test_team.py
13: from metagpt.roles import Architect, ProductManager, ProjectManager
14: from metagpt.team import Team
25: def test_team_deserialize(context):
26: company = Team(context=context)
28: pm = ProductManager()
34: ProjectManager(),
39: new_company = Team.model_validate(ser_company)
45: assert type(new_pm) == ProductManager
### 16 tests/metagpt/roles/di/test_team_leader.py
7: ProductManager,
8: ProjectManager,
12: from metagpt.roles.di.team_leader import TeamLeader
19: tl = TeamLeader()
29: ProductManager(),
31: ProjectManager(),
49: messages_to_team = [msg for msg in history if msg.sent_from == tl.name]
50: pm_messages = [msg for msg in messages_to_team if "Alice" in msg.send_to]
### 12 metagpt/tools/web_browser_engine_selenium.py
16: from webdriver_manager.core.download_manager import WDMDownloadManager
17: from webdriver_manager.core.http import WDMHttpClient
93: _webdriver_manager_types = {
94: "chrome": ("webdriver_manager.chrome", "ChromeDriverManager"),
95: "firefox": ("webdriver_manager.firefox", "GeckoDriverManager"),
96: "edge": ("webdriver_manager.microsoft", "EdgeChromiumDriverManager"),
97: "ie": ("webdriver_manager.microsoft", "IEDriverManager"),
118: module_name, type_name = _webdriver_manager_types[browser_type]
### 12 metagpt/context.py
19: from metagpt.utils.cost_manager import (
20: CostManager,
21: FireworksCostManager,
22: TokenCostManager,
66: cost_manager: CostManager = CostManager()
77: def _select_costmanager(self, llm_config: LLMConfig) -> CostManager:
78: """Return a CostManager instance"""
80: return FireworksCostManager()
### 10 tests/metagpt/test_team.py
3: # @Desc   : unittest of team
5: from metagpt.roles.project_manager import ProjectManager
6: from metagpt.team import Team
9: def test_team():
10: company = Team()
11: company.hire([ProjectManager()])

## OpenHands__OpenHands
### 54 frontend/src/routes/agent-settings.tsx
33: function findEnableSubAgentsField(
39: function getEnableSubAgentsValue(
80: // ── Sub-agents (OpenHands mode) ──────────────────────────────────────────
85: const subAgentsField = findEnableSubAgentsField(fields);
86: const initialSubAgentsEnabled = useMemo(
88: getEnableSubAgentsValue(
90: subAgentsField,
92: [subAgentsField, settings?.agent_settings],
### 37 frontend/src/components/features/controls/tools-context-menu.tsx
31: onShowAgentTools: (event: React.MouseEvent<HTMLButtonElement>) => void;
32: shouldShowAgentTools?: boolean;
40: onShowAgentTools,
41: shouldShowAgentTools = true,
131: {shouldShowAgentTools && <Divider />}
161: {shouldShowAgentTools && (
164: onClick={onShowAgentTools}
### 37 frontend/__tests__/components/features/conversation/conversation-name.test.tsx
408: onShowAgentTools: vi.fn(),
502: const onShowAgentTools = vi.fn();
507: onShowAgentTools={onShowAgentTools}
511: const showAgentToolsButton = screen.getByTestId("show-agent-tools-button");
512: await user.click(showAgentToolsButton);
514: expect(onShowAgentTools).toHaveBeenCalledTimes(1);
574: onShowAgentTools: vi.fn(),
### 36 frontend/src/routes/settings.tsx
37: "/settings/team",
80: // conversations (the sub-agent owns its own tools, LLM, condenser, MCP),
133: const isTeamOrg = !!selectedOrg && !selectedOrg.is_personal;
143: isTeamOrg
179: const { isTeamOrg } = useOrgTypeAndAccess();
185: const shouldShowOrgWideBadge = isOrgWideBadgePath && isTeamOrg && isSaasMode;
### 35 frontend/src/components/features/conversation/conversation-name-context-menu.tsx
35: onShowAgentTools?: (event: React.MouseEvent<HTMLButtonElement>) => void;
51: onShowAgentTools,
67: const hasTools = Boolean(onShowAgentTools || onShowSkills || onShowHooks);
123: {onShowAgentTools && (
126: onClick={onShowAgentTools}
### 34 frontend/src/components/features/conversation/conversation-name.tsx
39: handleShowAgentTools,
63: shouldShowAgentTools,
198: onShowAgentTools={
199: shouldShowAgentTools ? handleShowAgentTools : undefined
### 34 frontend/src/components/features/conversation-panel/conversation-card/conversation-card-context-menu.tsx
24: onShowAgentTools?: (event: React.MouseEvent<HTMLButtonElement>) => void;
40: onShowAgentTools,
96: onShowAgentTools && (
100: onClick={onShowAgentTools}
### 34 frontend/src/components/features/controls/tools.tsx
20: handleShowAgentTools,
30: shouldShowAgentTools,
61: onShowAgentTools={handleShowAgentTools}
62: shouldShowAgentTools={shouldShowAgentTools}
### 33 openhands/app_server/app_conversation/live_status_app_conversation_service.py
102: from openhands.sdk.subagent import get_registered_agent_definitions
1220: Finally delegates to ``ConversationSettings.create_request()``.
1525: # Mirror the regular path: populate ConversationSettings and delegate
### 33 frontend/src/hooks/use-conversation-name-context-menu.ts
117: const handleShowAgentTools = (event: React.MouseEvent<HTMLButtonElement>) => {
177: handleShowAgentTools,
208: shouldShowAgentTools: Boolean(showOptions && systemMessage),

## QwenLM__qwen-code
### 54 packages/core/src/utils/subagentGenerator.test.ts
19: subagentGenerator,
20: type SubagentGeneratedContent,
21: } from './subagentGenerator.js';
23: describe('subagentGenerator', () => {
47: subagentGenerator('', mockConfig, abortSignal),
51: subagentGenerator('   ', mockConfig, abortSignal),
59: const mockApiResponse: SubagentGeneratedContent = {
62: 'A specialized subagent that helps with code reviews and provides improvement suggestions.',
### 54 packages/core/src/tools/agent/fork-subagent.ts
4: export const FORK_SUBAGENT_TYPE = 'fork';
10: name: FORK_SUBAGENT_TYPE,
12: 'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type.',
15: 'You are a forked worker process. Follow the directive in the conversation history. Execute tasks directly using available tools. Do not spawn sub-agents.',
22: // fork subagent" via AsyncLocalStorage when dispatching; AgentTool.execute()
25: // Why ALS and not a history scan: the nested AgentTool's `this.config` is the
46: * Shared by the fork subagent (agent.ts) and background agent history
75: * Build extra history messages for a forked subagent.
### 54 packages/core/src/tools/agent/agent.ts
10: import { EXCLUDED_TOOLS_FOR_SUBAGENTS } from '../../agents/runtime/agent-core.js';
22: import type { SubagentManager } from '../../subagents/subagent-manager.js';
23: import type { SubagentConfig } from '../../subagents/types.js';
44: } from './fork-subagent.js';
61: AgentToolCallEvent,
62: AgentToolResultEvent,
68: import { BuiltinAgentRegistry } from '../../subagents/builtin-agents.js';
88: // execSync on a path that runs every time a subagent (foreground or
### 54 packages/core/src/tools/agent/agent.test.ts
9: AgentTool,
11: resolveSubagentApprovalMode,
18: import { SubagentManager } from '../../subagents/subagent-manager.js';
19: import type { SubagentConfig } from '../../subagents/types.js';
27: AgentToolCallEvent,
28: AgentToolResultEvent,
42: type AgentToolInvocation = {
54: type AgentToolWithProtectedMethods = AgentTool & {
### 54 packages/core/src/subagents/validation.ts
7: import { SubagentError, SubagentErrorCode } from './types.js';
8: import type { SubagentConfig, ValidationResult } from './types.js';
10: import { parseSubagentModelSelection } from './model-selection.js';
13: * Validates subagent configurations to ensure they are well-formed
16: export class SubagentValidator {
18: * Validates a complete subagent configuration.
20: * @param config - The subagent configuration to validate
23: validateConfig(config: SubagentConfig): ValidationResult {
### 54 packages/core/src/subagents/validation.test.ts
8: import { SubagentValidator } from './validation.js';
9: import { type SubagentConfig, SubagentError } from './types.js';
11: describe('SubagentValidator', () => {
12: let validator: SubagentValidator;
15: validator = new SubagentValidator();
28: '项目-manager',
209: 'Empty tools array - subagent will inherit all available tools',
347: const validConfig: SubagentConfig = {
### 54 packages/core/src/subagents/types.ts
8: * @fileoverview Subagent configuration types.
22: * Represents the storage level for a subagent configuration.
29: export type SubagentLevel =
37: * Core configuration for a subagent as stored in Markdown files.
41: export interface SubagentConfig {
42: /** Unique name identifier for the subagent */
45: /** Human-readable description of when and how to use this subagent */
49: * Optional list of tool names that this subagent is allowed to use.
### 54 packages/core/src/subagents/types.test.ts
8: import { SubagentError, SubagentErrorCode } from './types.js';
10: describe('SubagentError', () => {
12: const error = new SubagentError('Test error', SubagentErrorCode.NOT_FOUND);
15: expect(error.name).toBe('SubagentError');
17: expect(error.code).toBe(SubagentErrorCode.NOT_FOUND);
18: expect(error.subagentName).toBeUndefined();
21: it('should create error with subagent name', () => {
22: const error = new SubagentError(
### 54 packages/core/src/subagents/subagent-manager.ts
17: SubagentConfig,
18: SubagentRuntimeConfig,
19: SubagentLevel,
20: ListSubagentsOptions,
21: CreateSubagentOptions,
29: import { SubagentError, SubagentErrorCode } from './types.js';
30: import { SubagentValidator } from './validation.js';
42: import { parseSubagentModelSelection } from './model-selection.js';
### 54 packages/core/src/subagents/subagent-manager.test.ts
11: import { SubagentManager } from './subagent-manager.js';
12: import { type SubagentConfig, SubagentError } from './types.js';
36: SubagentValidator: class MockSubagentValidator {
42: vi.mock('./subagent.js');
84: describe('SubagentManager', () => {
85: let manager: SubagentManager;
102: // `buildSubagentContextOverride` now rebuilds the tool registry on
133: description: 'A test subagent',

## Significant-Gravitas__AutoGPT
### 54 classic/original_autogpt/autogpt/agents/prompt_strategies/multi_agent_debate.py
3: This strategy implements a multi-agent debate approach where multiple sub-agents
11: - Multiple sub-agents generate independent proposals
121: # Sub-agent configuration
169: Spawns multiple sub-agents that propose, critique, and debate
208: # Store commands for sub-agents
298: "The debate is starting. Sub-agents will now generate proposals. "
305: return "Sub-agents are critiquing proposals. Proceed to synthesis."
341: """Run the proposal phase with sub-agents."""
### 54 classic/original_autogpt/autogpt/agents/prompt_strategies/lats.py
6: LATS uses sub-agents to explore different reasoning paths with Monte Carlo Tree Search,
10: - Sub-agents explore different action paths in parallel
12: - Value function learned from sub-agent outcomes
48: EXPANSION = "expansion"  # Generate candidate actions via sub-agents
128: # Sub-agent configuration (inherited, but with LATS-specific defaults)
178: Uses sub-agents to explore different action paths with MCTS,
354: """Use sub-agents to generate candidate actions."""
356: self.logger.warning("Cannot spawn sub-agents for LATS expansion")
### 54 classic/original_autogpt/autogpt/agents/prompt_strategies/base.py
22: SubAgentHandle,
23: SubAgentStatus,
51: LATS = "lats"  # Language Agent Tree Search (sub-agent based)
52: MULTI_AGENT_DEBATE = "multi_agent_debate"  # Multi-agent debate (sub-agent based)
261: # Sub-agent configuration
263: """Enable sub-agent spawning for this strategy."""
266: """Maximum number of sub-agents that can be spawned."""
269: """Timeout for sub-agent execution in seconds."""
### 54 classic/original_autogpt/autogpt/agents/agent.py
35: from forge.components.file_manager import FileManagerComponent
66: from forge.permissions import CommandPermissionManager
140: permission_manager: Optional[CommandPermissionManager] = None,
143: super().__init__(settings, permission_manager=permission_manager)
185: self.file_manager = FileManagerComponent(
191: self.file_manager.workspace,
197: self.image_gen = ImageGeneratorComponent(self.file_manager.workspace)
203: self.context = ContextComponent(self.file_manager.workspace, settings.context)
### 54 classic/forge/forge/agent/execution_context.py
1: """Execution context for sub-agent support.
4: sub-agents. The ExecutionContext is passed down the agent hierarchy and provides
28: class SubAgentStatus(str, Enum):
29: """Status of a sub-agent."""
40: """Resource limits for sub-agent execution.
48: """Maximum nesting depth for sub-agents."""
51: """Maximum number of sub-agents that can be spawned."""
78: class SubAgentHandle:
### 54 autogpt_platform/frontend/src/app/(platform)/copilot/tools/RunAgent/helpers.tsx
26: export type RunAgentToolOutput =
44: output: RunAgentToolOutput,
53: output: RunAgentToolOutput,
61: output: RunAgentToolOutput,
67: output: RunAgentToolOutput,
73: output: RunAgentToolOutput,
79: output: RunAgentToolOutput,
84: function parseOutput(output: unknown): RunAgentToolOutput | null {
### 54 autogpt_platform/backend/backend/copilot/tools/run_agent_test.py
17: from .run_agent import RunAgentTool
45: tool = RunAgentTool()
86: tool = RunAgentTool()
122: tool = RunAgentTool()
160: tool = RunAgentTool()
202: tool = RunAgentTool()
238: tool = RunAgentTool()
270: tool = RunAgentTool()
### 53 autogpt_platform/backend/backend/copilot/tools/agent_generator/validator.py
748: 3. Sub-agent required inputs are connected via links (not hardcoded)
784: f"must reference the ID of the sub-agent to execute."
810: # Validate sub-agent inputs are properly linked (not hardcoded)
855: f"hardcoded input '{input_name}'. Sub-agent "
863: # Check for missing required sub-agent inputs.
887: f"missing required sub-agent input "
944: f"input_schema must define the sub-agent's expected "
945: f"inputs. This usually indicates the sub-agent "
### 51 autogpt_platform/frontend/src/app/(platform)/copilot/tools/CreateAgent/helpers.tsx
14: export type CreateAgentToolOutput =
20: function parseOutput(output: unknown): CreateAgentToolOutput | null {
39: return output as CreateAgentToolOutput;
52: export function getCreateAgentToolOutput(
54: ): CreateAgentToolOutput | null {
60: output: CreateAgentToolOutput,
68: output: CreateAgentToolOutput,
77: output: CreateAgentToolOutput,
### 50 classic/original_autogpt/autogpt/agent_factory/default_factory.py
1: """Default implementation of AgentFactory for sub-agent spawning.
3: This factory creates Agent instances for use as sub-agents within
25: Creates Agent instances for sub-agent spawning. Reuses the pattern
51: """Create a new agent instance for sub-agent execution.
70: ai_name=f"SubAgent-{agent_id[:8]}",
71: ai_role="A specialized sub-agent working on a specific task.",
104: # Sub-agents should always be non-interactive
133: AgentSettings configured for the sub-agent.

## TransformerOptimus__SuperAGI
### 44 superagi/jobs/agent_executor.py
8: from superagi.agent.agent_tool_step_handler import AgentToolStepHandler
109: tool_step_handler = AgentToolStepHandler(session,
### 44 superagi/agent/agent_tool_step_handler.py
24: from superagi.resource_manager.resource_summary import ResourceSummarizer
28: class AgentToolStepHandler:
### 37 tests/unit_tests/agent/test_agent_tool_step_handler.py
6: from superagi.agent.agent_tool_step_handler import AgentToolStepHandler
19: from superagi.resource_manager.resource_summary import ResourceSummarizer
32: handler = AgentToolStepHandler(mock_session, llm, agent_id, agent_execution_id, None)
### 18 superagi/agent/tool_builder.py
8: from superagi.resource_manager.file_manager import FileManager
10: from superagi.tools.tool_response_query_manager import ToolResponseQueryManager
113: if hasattr(tool, 'resource_manager'):
114: tool.resource_manager = FileManager(session=self.session, agent_id=self.agent_id,
116: if hasattr(tool, 'tool_response_manager'):
117: tool.tool_response_manager = ToolResponseQueryManager(session=self.session,
### 13 superagi/agent/workflow_seed.py
115: "List the files from the resource manager",
### 13 superagi/agent/agent_iteration_step_handler.py
29: from superagi.resource_manager.resource_summary import ResourceSummarizer
### 9 superagi/tools/code/write_test.py
14: from superagi.resource_manager.file_manager import FileManager
16: from superagi.tools.tool_response_query_manager import ToolResponseQueryManager
40: resource_manager: Manages the file resources
54: resource_manager: Optional[FileManager] = None
55: tool_response_manager: Optional[ToolResponseQueryManager] = None
75: spec_response = self.tool_response_manager.get_last_response("WriteSpecTool")
80: spec_response = self.tool_response_manager.get_last_response()
111: save_result = self.resource_manager.write_file(file_name, code)
### 8 superagi/tools/code/write_code.py
14: from superagi.resource_manager.file_manager import FileManager
16: from superagi.tools.tool_response_query_manager import ToolResponseQueryManager
36: resource_manager: Manages the file resources
51: resource_manager: Optional[FileManager] = None
52: tool_response_manager: Optional[ToolResponseQueryManager] = None
71: spec_response = self.tool_response_manager.get_last_response("WriteSpecTool")
107: save_result = self.resource_manager.write_file(file_name, code)
115: save_readme_result = self.resource_manager.write_file("README.md", readme)
### 8 superagi/tools/code/improve_code.py
14: from superagi.resource_manager.file_manager import FileManager
16: from superagi.tools.tool_response_query_manager import ToolResponseQueryManager
31: resource_manager: Manages the file resources.
41: resource_manager: Optional[FileManager] = None
42: tool_response_manager: Optional[ToolResponseQueryManager] = None
56: file_names = self.resource_manager.get_files()
62: content = self.resource_manager.read_file(file_name)
99: save_result = self.resource_manager.write_file(file_name, parsed_content_code)
### 6 superagi/worker.py
21: from superagi.helper.webhook_manager import WebHookManager
78: from superagi.resource_manager.resource_summary import ResourceSummarizer
81: from superagi.resource_manager.resource_manager import ResourceManager
96: documents = ResourceManager(str(agent_id)).create_llama_document_s3(file_path)
98: documents = ResourceManager(str(agent_id)).create_llama_document(file_path)
111: WebHookManager(session).agent_status_change_callback(agent_execution_id, val, old_val)

## aaif-goose__goose
### 54 crates/goose/src/agents/subagent_handler.rs
2: agents::{subagent_task_config::TaskConfig, Agent, AgentConfig, AgentEvent, SessionConfig},
26: pub struct SubagentPromptContext {
28: pub subagent_id: String,
37: pub struct SubagentRunParams {
48: pub async fn run_subagent_task(params: SubagentRunParams) -> Result<String, anyhow::Error> {
120: pub const SUBAGENT_TOOL_REQUEST_TYPE: &str = "subagent_tool_request";
122: fn get_agent_messages(params: SubagentRunParams) -> AgentMessagesFuture {
124: let SubagentRunParams {
### 54 crates/goose/src/agents/prompt_manager.rs
22: pub struct PromptManager {
29: impl Default for PromptManager {
31: PromptManager::new()
43: enable_subagents: bool,
50: manager: &'a M,
55: subagents_enabled: bool,
61: impl<'a> SystemPromptBuilder<'a, PromptManager> {
105: pub fn with_enable_subagents(mut self, subagents_enabled: bool) -> Self {
### 54 crates/goose/src/agents/platform_extensions/summon.rs
3: use crate::agents::subagent_handler::{run_subagent_task, OnMessageCallback, SubagentRunParams};
4: use crate::agents::subagent_task_config::{TaskConfig, DEFAULT_SUBAGENT_MAX_TURNS};
58: pub struct DelegateParams {
411: fn create_delegate_tool(&self) -> Tool {
448: "description": "Maximum turns for this delegate. Overrides recipe settings.max_turns and GOOSE_SUBAGENT_MAX_TURNS."
459: "delegate",
460: "Delegate a task to a subagent that runs independently with its own context.\n\n\
466: - Delegates know only instructions + source content\n\
### 54 crates/goose/src/agents/platform_extensions/mod.rs
7: pub mod ext_manager;
20: pub use ext_manager::MANAGE_EXTENSIONS_TOOL_NAME_COMPLETE;
24: pub use ext_manager::MANAGE_EXTENSIONS_TOOL_NAME;
26: pub use ext_manager::SEARCH_AVAILABLE_EXTENSIONS_TOOL_NAME;
70: client_factory: |ctx| Box::new(apps::AppsManagerClient::new(ctx).unwrap()),
89: "extensionmanager",
91: name: ext_manager::EXTENSION_NAME,
92: display_name: "Extension Manager",
### 51 crates/goose/src/agents/mod.rs
6: pub mod extension_manager;
13: pub mod prompt_manager;
17: pub mod subagent_execution_tool;
18: pub(crate) mod subagent_handler;
19: pub(crate) mod subagent_task_config;
29: pub use extension_manager::ExtensionManager;
30: pub use prompt_manager::PromptManager;
31: pub use subagent_handler::SUBAGENT_TOOL_REQUEST_TYPE;
### 49 ui/goose2/src/shared/ui/ai-elements/agent.tsx
77: export type AgentToolsProps = ComponentProps<typeof Accordion>;
79: export const AgentTools = memo(({ className, ...props }: AgentToolsProps) => (
86: export type AgentToolProps = ComponentProps<typeof AccordionItem> & {
90: export const AgentTool = memo(
91: ({ className, tool, value, ...props }: AgentToolProps) => {
137: AgentTools.displayName = "AgentTools";
138: AgentTool.displayName = "AgentTool";
### 47 crates/goose/src/agents/platform_extensions/summarize.rs
52: let extension_manager = self
54: .extension_manager
57: .ok_or("Extension manager not available")?;
59: let provider_guard = extension_manager.get_provider().lock().await;
77: More efficient than subagent when you know what to analyze. \
### 46 crates/goose/src/agents/platform_extensions/analyze/mod.rs
66: For large codebases, delegate analysis to a subagent and retain only the summary.
270: use crate::session::SessionManager;
278: extension_manager: None,
279: session_manager: Arc::new(SessionManager::new(std::env::temp_dir())),
### 45 crates/goose/src/agents/subagent_task_config.rs
9: pub const DEFAULT_SUBAGENT_MAX_TURNS: usize = 25;
47: .get_param::<usize>("GOOSE_SUBAGENT_MAX_TURNS")
48: .unwrap_or(DEFAULT_SUBAGENT_MAX_TURNS),
### 44 crates/goose-cli/src/session/task_execution_display/mod.rs
1: use goose::agents::subagent_execution_tool::lib::TaskStatus;
2: use goose::agents::subagent_execution_tool::notification_events::{

## agno-agi__agno
### 53 cookbook/01_demo/teams/swarm.py
2: Swarm Team — same question, multiple models in parallel
5: Broadcast-mode team. Two web-search agents — one on OpenAI gpt-5.5,
19: from agno.team import Team
20: from agno.team.mode import TeamMode
58: SWARM_INSTRUCTIONS = """\
59: You lead a two-model swarm: one OpenAI agent and one Anthropic
75: swarm = Team(
76: id="swarm",
### 44 cookbook/01_demo/agents/local_wiki.py
7: query_local_wiki(question)   — read sub-agent scoped to the wiki
8: update_local_wiki(...)       — write sub-agent that can also fetch
### 43 cookbook/01_demo/agents/web_search.py
7: The agent sees a single ``query_web(question)`` tool that hands off to a sub-agent with ``web_search`` + ``web_fetch``. The sub-agent does the search/fetch loop and returns a synthesized answer; the parent agent stays fo
### 43 cookbook/01_demo/agents/code_search.py
7: Uses ``WorkspaceContextProvider``, which exposes a read-only ``Workspace`` toolkit (list / search / read) behind a sub-agent.
### 42 libs/agno/agno/context/gmail/provider.py
12: Separate sub-agents keep each scope narrow. Reads get search and
18: - Set ``GOOGLE_SERVICE_ACCOUNT_FILE`` and ``GOOGLE_DELEGATED_USER``
19: - Gmail requires ``delegated_user`` because service accounts have no inbox
140: delegated_user: str | None = None,
159: self._delegated_user: str | None = None
162: self._delegated_user = delegated_user or getenv("GOOGLE_DELEGATED_USER")
163: if not self._delegated_user:
165: "GmailContextProvider requires delegated_user with service account. "
### 40 libs/agno/agno/context/wiki/provider.py
7: - ``query_<id>`` — natural-language reads, backed by a sub-agent with
9: - ``update_<id>`` — natural-language writes, backed by a sub-agent
11: the sub-agent returns, the backend's ``commit_after_write`` hook
59: # sub-agent gets the backend's tools (typically web_search +
94: # sub-agent so a re-setup builds fresh tools, then forward
140: # Pull before writing so the sub-agent sees the latest
194: # Sub-agents
213: # Append the web backend's tools so the same sub-agent
### 39 libs/agno/agno/context/calendar/provider.py
12: Separate sub-agents keep each scope narrow. Reads get list/search
18: - Set ``GOOGLE_SERVICE_ACCOUNT_FILE`` and optionally ``GOOGLE_DELEGATED_USER``
19: - Without ``delegated_user``, operates on the service account's own calendar
127: delegated_user: str | None = None,
147: # Calendar does NOT require delegated_user — SA can use its own calendar
148: self._delegated_user = delegated_user or getenv("GOOGLE_DELEGATED_USER") if self._sa_path else None
162: delegated_user=self._delegated_user,
235: delegated_user=self._delegated_user,
### 37 libs/agno/agno/context/mcp/provider.py
7: tool on the calling agent (via the sub-agent wrapper).
9: Why a sub-agent wrapper:
12: we flattened them onto the calling agent's tool list. The sub-agent
15: updates. The sub-agent's instructions are built from
170: f"this MCP server. Routes through a sub-agent that picks among the "
179: # Always wrap behind a sub-agent — two MCP servers with a shared
264: """Lazy-build the sub-agent AFTER the MCP session is connected
### 37 cookbook/01_demo/evals/cases.py
25: from agno.team import Team
28: from teams.swarm import swarm
35: """One eval case: an input to one agent/team/workflow + optional judge/reliability checks."""
38: agent: Union[Agent, Team, Workflow]
106: # Swarm team — both models answer, leader synthesizes with disagreements + confidence.
108: name="swarm_synthesizes_two_models",
109: agent=swarm,
### 36 libs/agno/agno/context/wiki/backend.py
5: The provider owns the agent-facing contract (two tools, two sub-agents).
80: Subclasses own the on-disk path the sub-agents read and write
104: doesn't serve stale content to a read sub-agent.
109: """Persist any changes the write sub-agent made. Return ``None`` if nothing changed.
117: to summarise a diff can reuse the same model the sub-agents
130: # Helper for write sub-agents

## anomalyco__opencode
### 54 packages/opencode/src/tool/task.ts
10: import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
31: "Background mode: background=true launches the subagent asynchronously.",
39: subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
42: "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
50: subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
53: "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
57: description: "When true, launch the subagent in the background and return immediately",
103: export const TaskTool = Tool.define(
### 54 packages/opencode/src/cli/cmd/run/subagent-data.ts
10: import type { FooterSubagentState, FooterSubagentTab, StreamCommit } from "./types"
12: export const SUBAGENT_BOOTSTRAP_LIMIT = 200
13: export const SUBAGENT_CALL_BOOTSTRAP_LIMIT = 80
15: const SUBAGENT_COMMIT_LIMIT = 80
16: const SUBAGENT_CALL_LIMIT = 32
17: const SUBAGENT_ROLE_LIMIT = 32
18: const SUBAGENT_ERROR_LIMIT = 16
19: const SUBAGENT_ECHO_LIMIT = 8
### 54 packages/opencode/src/cli/cmd/run/footer.subagent.tsx
8: import type { FooterSubagentDetail, FooterSubagentTab, RunDiffStyle } from "./types"
11: export const SUBAGENT_TAB_ROWS = 2
12: export const SUBAGENT_INSPECTOR_ROWS = 8
14: function statusColor(theme: RunFooterTheme, status: FooterSubagentTab["status"]) {
26: function statusIcon(status: FooterSubagentTab["status"]) {
38: function tabText(tab: FooterSubagentTab, slot: string, count: number, width: number) {
53: export function RunFooterSubagentTabs(props: {
54: tabs: FooterSubagentTab[]
### 54 packages/opencode/src/acp/agent.ts
40: import { ACPSessionManager } from "./session"
146: private sessionManager: ACPSessionManager
162: this.sessionManager = new ACPSessionManager(this.sdk)
196: const session = this.sessionManager.tryGet(permission.sessionID)
279: const session = this.sessionManager.tryGet(part.sessionID)
442: const session = this.sessionManager.tryGet(props.sessionID)
564: const state = await this.sessionManager.create(params.cwd, params.mcpServers, model)
601: await this.sessionManager.load(sessionId, params.cwd, params.mcpServers, model)
### 50 packages/opencode/src/cli/cmd/tui/routes/session/subagent-footer.tsx
12: export function SubagentFooter() {
18: const subagentInfo = createMemo(() => {
20: if (!s) return { label: "Subagent", index: 0, total: 0 }
21: const agentMatch = s.title.match(/@(\w+) subagent/)
22: const label = agentMatch ? Locale.titlecase(agentMatch[1]) : "Subagent"
82: <b>{subagentInfo().label}</b>
84: <Show when={subagentInfo().total > 0}>
86: ({subagentInfo().index} of {subagentInfo().total})
### 50 packages/opencode/src/agent/subagent-permissions.ts
5: * Build the `permission` ruleset for a subagent's session when it's spawned
6: * via the task tool. Combines:
10: *    subagent that only inherited the parent SESSION's permission would
14: * 3. Default `todowrite` and `task` denies if the subagent's own ruleset
17: export function deriveSubagentSessionPermission(input: {
20: subagent: Agent.Info
22: const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
23: const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
### 48 packages/opencode/src/cli/cmd/agent.ts
17: type AgentMode = "all" | "primary" | "subagent"
52: choices: ["all", "primary", "subagent"] as const,
167: hint: "Can function in both primary and subagent roles",
175: label: "Subagent",
176: value: "subagent" as const,
177: hint: "Can be used as a subagent by other agents",
### 48 packages/opencode/src/agent/agent.ts
31: mode: Schema.Literals(["subagent", "primary", "all"]),
176: mode: "subagent",
199: mode: "subagent",
227: mode: "subagent" as const,
346: if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
350: const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
### 48 packages/app/src/pages/session/handoff.ts
3: type HandoffSession = {
11: session: new Map<string, HandoffSession>(),
25: export const setSessionHandoff = (key: string, patch: Partial<HandoffSession>) => {
30: export const getSessionHandoff = (key: string) => store.session.get(key)
32: export const setTerminalHandoff = (key: string, value: string[]) => {
36: export const getTerminalHandoff = (key: string) => store.terminal.get(key)
### 46 packages/opencode/test/tool/task.test.ts
15: import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
47: const background = testEffect(layer({ experimentalBackgroundSubagents: true }))
57: const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
131: "description sorts subagents by name and is stable across calls",
139: return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
161: mode: "subagent",
165: mode: "subagent",
173: "description hides denied subagents for the caller",

## crewAIInc__crewAI
### 54 lib/crewai/src/crewai/agents/agent_adapters/openai_agents/openai_agent_tool_adapter.py
1: """OpenAI agent tool adapter for CrewAI tool integration.
3: This module contains the OpenAIAgentToolAdapter class that converts CrewAI tools
12: from crewai.agents.agent_adapters.base_tool_adapter import BaseToolAdapter
13: from crewai.agents.agent_adapters.openai_agents.protocols import (
17: from crewai.tools import BaseTool
18: from crewai.utilities.import_utils import require
19: from crewai.utilities.pydantic_schema_utils import force_additional_properties_false
20: from crewai.utilities.string_utils import sanitize_tool_name
### 54 lib/crewai/src/crewai/agents/agent_adapters/openai_agents/openai_adapter.py
1: """OpenAI agents adapter for CrewAI integration.
4: with CrewAI's agent system, providing tool integration and structured output support.
13: from crewai.agents.agent_adapters.base_agent_adapter import BaseAgentAdapter
14: from crewai.agents.agent_adapters.openai_agents.openai_agent_tool_adapter import (
15: OpenAIAgentToolAdapter,
17: from crewai.agents.agent_adapters.openai_agents.protocols import (
22: from crewai.agents.agent_adapters.openai_agents.structured_output_converter import (
25: from crewai.agents.agent_builder.base_agent import BaseAgent
### 54 lib/crewai/src/crewai/agents/agent_adapters/langgraph/langgraph_adapter.py
1: """LangGraph agent adapter for CrewAI integration.
4: with CrewAI's agent system. Provides memory persistence, tool integration, and structured
13: from crewai.agents.agent_adapters.base_agent_adapter import BaseAgentAdapter
14: from crewai.agents.agent_adapters.langgraph.langgraph_tool_adapter import (
17: from crewai.agents.agent_adapters.langgraph.protocols import (
21: from crewai.agents.agent_adapters.langgraph.structured_output_converter import (
24: from crewai.agents.agent_builder.base_agent import BaseAgent
25: from crewai.events.event_bus import crewai_event_bus
### 54 lib/crewai-tools/src/crewai_tools/aws/bedrock/code_interpreter/code_interpreter_toolkit.py
9: from crewai.tools import BaseTool
393: class GetTaskTool(BaseTool):
426: class StopTaskTool(BaseTool):
479: from crewai import Agent, Task, Crew
480: from crewai_tools.aws.bedrock.code_interpreter import (
487: # Create a CrewAI agent that uses the code interpreter tools
501: # Create and run the crew
502: crew = Crew(agents=[developer_agent], tasks=[coding_task])
### 54 lib/crewai-tools/src/crewai_tools/__init__.py
1: from crewai_tools.adapters.enterprise_adapter import EnterpriseActionTool
2: from crewai_tools.adapters.mcp_adapter import MCPServerAdapter
3: from crewai_tools.adapters.zapier_adapter import ZapierActionTool
4: from crewai_tools.aws.bedrock.agents.invoke_agent_tool import BedrockInvokeAgentTool
5: from crewai_tools.aws.bedrock.knowledge_base.retriever_tool import (
8: from crewai_tools.aws.s3.reader_tool import S3ReaderTool
9: from crewai_tools.aws.s3.writer_tool import S3WriterTool
10: from crewai_tools.tools.ai_mind_tool.ai_mind_tool import AIMindTool
### 52 lib/crewai/src/crewai/tools/agent_tools/agent_tools.py
6: from crewai.tools.agent_tools.ask_question_tool import AskQuestionTool
7: from crewai.tools.agent_tools.delegate_work_tool import DelegateWorkTool
8: from crewai.utilities.i18n import I18N_DEFAULT
12: from crewai.agents.agent_builder.base_agent import BaseAgent
13: from crewai.tools.base_tool import BaseTool
16: class AgentTools:
17: """Manager class for agent-related tools"""
26: delegate_tool = DelegateWorkTool(
### 51 lib/crewai/src/crewai/tools/agent_tools/base_agent_tools.py
6: from crewai.agents.agent_builder.base_agent import BaseAgent
7: from crewai.task import Task
8: from crewai.tools.base_tool import BaseTool
9: from crewai.utilities.i18n import I18N_DEFAULT
15: class BaseAgentTool(BaseTool):
55: agent_name: Name/role of the agent to delegate to (case-insensitive)
56: task: The specific question or task to delegate
60: str: The execution result from the delegated agent or an error message
### 49 lib/crewai/src/crewai/tools/agent_tools/delegate_work_tool.py
5: from crewai.tools.agent_tools.base_agent_tools import BaseAgentTool
8: class DelegateWorkToolSchema(BaseModel):
9: task: str = Field(..., description="The task to delegate")
12: ..., description="The role/name of the coworker to delegate to"
16: class DelegateWorkTool(BaseAgentTool):
19: name: str = "Delegate work to coworker"
20: args_schema: type[BaseModel] = DelegateWorkToolSchema
### 49 lib/crewai-tools/src/crewai_tools/aws/bedrock/agents/invoke_agent_tool.py
7: from crewai.tools import BaseTool
11: from crewai_tools.aws.bedrock.exceptions import (
21: class BedrockInvokeAgentToolInput(BaseModel):
22: """Input schema for BedrockInvokeAgentTool."""
27: class BedrockInvokeAgentTool(BaseTool):
30: args_schema: type[BaseModel] = BedrockInvokeAgentToolInput
48: """Initialize the BedrockInvokeAgentTool with agent configuration.
### 47 lib/crewai-tools/src/crewai_tools/aws/bedrock/__init__.py
1: from crewai_tools.aws.bedrock.agents.invoke_agent_tool import BedrockInvokeAgentTool
2: from crewai_tools.aws.bedrock.browser import create_browser_toolkit
3: from crewai_tools.aws.bedrock.code_interpreter import create_code_interpreter_toolkit
4: from crewai_tools.aws.bedrock.knowledge_base.retriever_tool import (
10: "BedrockInvokeAgentTool",

## google-gemini__gemini-cli
### 54 packages/core/src/agents/types.ts
70: * Structured events emitted during subagent execution for user observability.
72: export enum SubagentActivityErrorType {
79: * Standard error messages for subagent activities.
81: export const SUBAGENT_REJECTED_ERROR_PREFIX = 'User rejected this operation.';
82: export const SUBAGENT_CANCELLED_ERROR_MESSAGE = 'Request cancelled.';
84: export interface SubagentActivityEvent {
85: isSubagentActivityEvent: true;
91: export enum SubagentState {
### 54 packages/core/src/agents/remote-subagent-protocol.ts
8: * @fileoverview RemoteSubagentProtocol — wraps A2A remote agent streaming
11: * Pattern mirrors LocalSubagentProtocol and LegacyAgentProtocol, but the loop
12: * body drives A2AClientManager instead of LocalAgentExecutor.
30: type SubagentProgress,
31: SubagentState,
51: // RemoteSubagentProtocol
54: class RemoteSubagentProtocol implements AgentProtocol {
69: // Agent display name (for SubagentProgress construction)
### 54 packages/core/src/agents/remote-subagent-protocol.test.ts
16: import { RemoteSubagentSession } from './remote-subagent-protocol.js';
19: import type { RemoteAgentDefinition, SubagentProgress } from './types.js';
26: // Mock A2AClientManager at module level
27: vi.mock('./a2a-client-manager.js', () => ({
28: A2AClientManager: vi.fn().mockImplementation(() => ({
62: describe('RemoteSubagentSession (protocol)', () => {
63: let mockClientManager: {
77: mockClientManager = {
### 54 packages/core/src/agents/remote-invocation.ts
19: type SubagentProgress,
20: SubagentState,
27: A2AClientManager,
29: } from './a2a-client-manager.js';
55: private readonly clientManager: A2AClientManager;
79: const clientManager = this.context.config.getA2AClientManager();
80: if (!clientManager) {
82: `Failed to initialize RemoteAgentInvocation for '${definition.name}': A2AClientManager is not available.`,
### 54 packages/core/src/agents/remote-invocation.test.ts
20: type A2AClientManager,
21: } from './a2a-client-manager.js';
25: type SubagentProgress,
26: SubagentState,
34: // Mock A2AClientManager
35: vi.mock('./a2a-client-manager.js', () => ({
36: A2AClientManager: vi.fn().mockImplementation(() => ({
62: let mockClientManager: {
### 54 packages/core/src/agents/local-subagent-protocol.ts
8: * @fileoverview LocalSubagentProtocol — wraps LocalAgentExecutor behind the
9: * AgentProtocol interface, translating SubagentActivityEvent callbacks into
33: type SubagentActivityEvent,
66: // LocalSubagentProtocol
69: class LocalSubagentProtocol implements AgentProtocol {
93: activity: SubagentActivityEvent,
127: 'LocalSubagentProtocol.send() cannot be called while a stream is active.',
170: * Used by LocalSubagentInvocation to build the ToolResult.
### 54 packages/core/src/agents/local-subagent-protocol.test.ts
8: import { LocalSubagentSession } from './local-subagent-protocol.js';
13: type SubagentActivityEvent,
29: let capturedOnActivity: ((activity: SubagentActivityEvent) => void) | undefined;
54: describe('LocalSubagentSession (protocol)', () => {
92: const session = new LocalSubagentSession(
115: const session = new LocalSubagentSession(
134: const session = new LocalSubagentSession(
155: const session = new LocalSubagentSession(
### 54 packages/core/src/agents/local-invocation.ts
18: type SubagentActivityEvent,
19: type SubagentProgress,
20: type SubagentActivityItem,
22: SubagentActivityErrorType,
23: SUBAGENT_REJECTED_ERROR_PREFIX,
24: SUBAGENT_CANCELLED_ERROR_MESSAGE,
26: SubagentState,
42: * Represents a validated, executable instance of a subagent tool.
### 54 packages/core/src/agents/local-invocation.test.ts
19: type SubagentActivityEvent,
21: type SubagentProgress,
22: SubagentActivityErrorType,
23: SUBAGENT_REJECTED_ERROR_PREFIX,
24: SubagentState,
26: import { LocalSubagentInvocation } from './local-invocation.js';
66: describe('LocalSubagentInvocation', () => {
97: const invocation = new LocalSubagentInvocation(
### 54 packages/core/src/agents/local-executor.ts
54: SubagentActivityErrorType,
55: SUBAGENT_REJECTED_ERROR_PREFIX,
56: SUBAGENT_CANCELLED_ERROR_MESSAGE,
60: type SubagentActivityEvent,
73: import { scheduleAgentTools } from './agent-scheduler.js';
86: import { CompleteTaskTool } from '../tools/complete-task.js';
94: export type ActivityCallback = (activity: SubagentActivityEvent) => void;
140: sandboxManager: this.context.sandboxManager,

## langchain-ai__deepagents
### 54 libs/deepagents/deepagents/profiles/harness/harness_profiles.py
11: prompt assembly, tool visibility, middleware, and default subagent behavior
76: "(back filesystem tools, subagent dispatch, and permission "
83: class GeneralPurposeSubagentProfile:
84: """Edits applied to the auto-added `general-purpose` subagent.
92: These settings only affect the default subagent that `create_deep_agent`
93: inserts when the caller does not explicitly provide a subagent named
98: """Whether to auto-add the default general-purpose subagent (three-state:
102: the default of including the subagent. `True` forces inclusion and is
### 54 libs/deepagents/deepagents/middleware/subagents.py
1: """Middleware for providing subagents to an agent via a `task` tool."""
27: class SubAgent(TypedDict):
30: When using `create_deep_agent`, subagents automatically receive
35: name: Unique identifier for the subagent.
38: description: What this subagent does.
41: to decide when to delegate.
42: system_prompt: Instructions for the subagent.
47: tools: Tools the subagent can use.
### 54 libs/deepagents/deepagents/middleware/async_subagents.py
1: """Middleware for async subagents running on remote Agent Protocol servers.
3: Async subagents use the LangGraph SDK to launch background runs on remote
5: Unlike synchronous subagents (which block until completion), async subagents
7: send updates while the subagent works.
34: class AsyncSubAgent(TypedDict):
35: """Specification for an async subagent running on a remote [Agent Protocol](https://github.com/langchain-ai/agent-protocol) server.
37: Async subagents connect to any Agent Protocol-compliant server via the
49: """Unique identifier for the async subagent."""
### 54 libs/deepagents/deepagents/graph.py
5: subagent, and summarization middleware.
36: from deepagents._subagent_transformer import SubagentTransformer
42: from deepagents.middleware.async_subagents import AsyncSubAgent, AsyncSubAgentMiddleware
47: from deepagents.middleware.subagents import (
48: GENERAL_PURPOSE_SUBAGENT,
49: CompiledSubAgent,
50: SubAgent,
51: SubAgentMiddleware,
### 54 libs/deepagents/deepagents/_subagent_transformer.py
1: """Surface declared subagents as typed `run.subagents` handles.
5: `subagent_type` and the user-facing `tool_call_id` only live in the
12: ``parent_task_id → (subagent_type, tool_call_id)``.
15: subagent name, build a `SubagentRunStream` (or async variant)
16: wrapping a child mini-mux and push it onto the `subagents` log.
17: The handle reports `graph_name` as the subagent's declared type
21: A subagent therefore shows up on **both** `run.subgraphs` (untyped,
22: superset, keyed by the raw Pregel segment) and `run.subagents`
### 54 libs/deepagents/deepagents/__init__.py
3: from deepagents._subagent_transformer import (
4: AsyncSubagentRunStream,
5: SubagentRunStream,
6: SubagentTransformer,
10: from deepagents.middleware.async_subagents import AsyncSubAgent, AsyncSubAgentMiddleware
13: from deepagents.middleware.subagents import CompiledSubAgent, SubAgent, SubAgentMiddleware
15: GeneralPurposeSubagentProfile,
26: "AsyncSubAgent",
### 54 libs/code/deepagents_code/subagents.py
1: """Subagent loader for app.
3: Loads custom subagent definitions from the filesystem. Subagents are defined
34: class SubagentMetadata(TypedDict):
35: """Metadata for a custom subagent loaded from filesystem."""
38: """Unique identifier for the subagent, used with the task tool."""
41: """What this subagent does. Main agent uses this to decide when to delegate."""
44: """Instructions for the subagent (body of the markdown file)."""
50: """Where this subagent was loaded from ('user' or 'project')."""
### 54 libs/code/deepagents_code/server_graph.py
28: _mcp_session_manager: Any = None
45: def _get_mcp_session_manager() -> Any:  # noqa: ANN401
46: """Return the process-wide MCP session manager singleton.
54: global _mcp_session_manager  # noqa: PLW0603
56: if _mcp_session_manager is None:
57: from deepagents_code.mcp_tools import MCPSessionManager
59: _mcp_session_manager = MCPSessionManager()
61: return _mcp_session_manager
### 54 libs/code/deepagents_code/main.py
174: """Fallback installation URL when no platform package manager is detected."""
397: session_manager = None
404: _tools, session_manager, server_info = await resolve_and_load_mcp_tools(
412: if session_manager is not None:
414: await session_manager.cleanup()
1166: from deepagents_code.agent import create_cli_agent, load_async_subagents
1190: mcp_session_manager = None
1197: mcp_session_manager,
### 54 libs/code/deepagents_code/agent.py
35: from deepagents.middleware.async_subagents import AsyncSubAgent
36: from deepagents.middleware.subagents import CompiledSubAgent, SubAgent
72: from deepagents_code.subagents import list_subagents
201: def load_async_subagents(config_path: Path | None = None) -> list[AsyncSubAgent]:
202: """Load async subagent definitions from `config.toml`.
204: Reads the `[async_subagents]` section where each sub-table defines a remote
208: [async_subagents.researcher]
220: List of `AsyncSubAgent` specs (empty if section is absent or invalid).

## langchain-ai__langchain
### 46 libs/langchain_v1/tests/unit_tests/agents/test_subagent_streaming.py
1: """Regression tests for subagent stream event propagation.
5: ``values``, and ``custom`` stream events from sub-agents invoked through
18: def _make_subagent_caller_tool():
19: """Build a subagent and a tool that invokes it."""
20: subagent = create_agent(
22: name="subagent",
26: def call_subagent(query: str) -> str:
27: """Delegate the query to a sub-agent."""
### 39 libs/langchain/langchain_classic/chains/router/llm_router.py
9: AsyncCallbackManagerForChainRun,
10: CallbackManagerForChainRun,
29: "Build routing logic with `create_agent` (e.g. with subagents or "
133: run_manager: CallbackManagerForChainRun | None = None,
135: _run_manager = run_manager or CallbackManagerForChainRun.get_noop_manager()
136: callbacks = _run_manager.get_child()
147: run_manager: AsyncCallbackManagerForChainRun | None = None,
149: _run_manager = run_manager or CallbackManagerForChainRun.get_noop_manager()
### 36 libs/langchain_v1/tests/unit_tests/agents/test_agent_streaming.py
195: Wiring a sub-agent through a `@tool` is the canonical pattern
213: """Delegate `query` to the inner agent and return its reply."""
### 34 libs/core/tests/unit_tests/runnables/test_tracing_interops.py
19: from langchain_core.callbacks.manager import CallbackManager
94: callbacks = CallbackManager.configure(
118: def test_config_traceable_handoff() -> None:
202: async def test_config_traceable_async_handoff() -> None:
754: so the callback manager's shared metadata dict is not mutated.
847: callbacks = CallbackManager.configure(
896: callbacks = CallbackManager.configure(
923: async def test_langsmith_inheritable_metadata_mixed_sync_async_managers_isolated() -> (
### 32 libs/core/langchain_core/tracers/langchain.py
47: so nested callers (e.g. a subagent) can replace a value inherited from an
478: # so a nested caller (e.g. a subagent) can override a parent-set value.
### 31 libs/langchain/langchain_classic/chains/router/multi_prompt.py
30: "Build routing logic with `create_agent` (e.g. with subagents or "
### 26 libs/core/tests/unit_tests/tracers/test_langchain.py
812: tracer = self._make_tracer(metadata={"ls_agent_type": "subagent"})
817: assert run.metadata["ls_agent_type"] == "subagent"
944: metadata={"ls_agent_type": "subagent", "env": "prod"},
949: "ls_agent_type": "subagent",
### 26 libs/core/tests/unit_tests/language_models/test_compat_bridge.py
344: "args": '{"subagent_type": "haiku"',
359: "args": '{"subagent_type": "limerick"',
416: "subagent_type": "haiku",
421: "subagent_type": "limerick",
### 24 libs/langchain/langchain_classic/agents/agent_iterator.py
19: AsyncCallbackManager,
20: AsyncCallbackManagerForChainRun,
21: CallbackManager,
22: CallbackManagerForChainRun,
151: run_manager: CallbackManagerForChainRun | AsyncCallbackManagerForChainRun,
157: run_manager: The run manager to use for callbacks.
170: prepared_outputs[RUN_KEY] = RunInfo(run_id=run_manager.run_id)
177: callback_manager = CallbackManager.configure(
### 24 libs/langchain/langchain_classic/agents/agent.py
23: AsyncCallbackManagerForChainRun,
24: AsyncCallbackManagerForToolRun,
25: BaseCallbackManager,
26: CallbackManagerForChainRun,
27: CallbackManagerForToolRun,
143: callback_manager: BaseCallbackManager | None = None,
151: callback_manager: Callback manager to use.
889: callback_manager: BaseCallbackManager | None = None,

## langchain-ai__langgraph
### 34 libs/prebuilt/tests/test_tool_node.py
631: def transfer_to_bob(tool_call_id: Annotated[str, InjectedToolCallId]):
644: async def async_transfer_to_bob(tool_call_id: Annotated[str, InjectedToolCallId]):
689: name="custom_transfer_to_bob",
694: name="async_custom_transfer_to_bob",
706: {"args": {}, "id": "2", "name": "transfer_to_bob", "type": "tool_call"},
712: result = ToolNode([add, transfer_to_bob]).invoke(
732: name="transfer_to_bob",
744: for tool in [transfer_to_bob, custom_tool]:
### 33 libs/sdk-py/langgraph_sdk/_async/client.py
89: subagent_result = await client.runs.wait(
163: """Enter the async context manager."""
172: """Exit the async context manager."""
### 14 libs/langgraph/bench/react_agent.py
4: from langchain_core.callbacks import CallbackManagerForLLMRun
26: run_manager: CallbackManagerForLLMRun | None = None,
### 12 libs/langgraph/langgraph/pregel/main.py
41: get_async_callback_manager_for_config,
42: get_callback_manager_for_config,
107: get_async_graph_callback_manager_for_config,
108: get_sync_graph_callback_manager_for_config,
504: - `Context`: exposes the value of a context manager, managing its lifecycle.
1192: manager=None,
1315: manager=None,
1623: # delegate to subgraph
### 12 libs/langgraph/langgraph/pregel/_loop.py
9: AbstractAsyncContextManager,
10: AbstractContextManager,
24: from langchain_core.callbacks import AsyncParentRunManager, ParentRunManager
172: manager: None | AsyncParentRunManager | ParentRunManager
284: manager: None | AsyncParentRunManager | ParentRunManager = None,
305: self.manager = manager
558: manager=self.manager,
606: manager=self.manager,
### 12 libs/langgraph/langgraph/pregel/_algo.py
22: from langchain_core.callbacks.manager import AsyncParentRunManager, ParentRunManager
362: manager: Literal[None] = None,
384: manager: None | ParentRunManager | AsyncParentRunManager,
405: manager: None | ParentRunManager | AsyncParentRunManager = None,
424: manager: The parent run manager to use for the tasks.
461: manager=manager,
507: manager=manager,
541: manager: None | ParentRunManager | AsyncParentRunManager = None,
### 12 libs/langgraph/langgraph/callbacks.py
14: from langchain_core.callbacks import BaseCallbackHandler, BaseCallbackManager
15: from langchain_core.callbacks.manager import ahandle_event, handle_event
26: "get_async_graph_callback_manager_for_config",
27: "get_sync_graph_callback_manager_for_config",
123: def _init_base_manager(
124: manager: BaseCallbackManager,
141: BaseCallbackManager.__init__(
142: manager,
### 12 libs/langgraph/langgraph/_internal/_runnable.py
17: from contextlib import AsyncExitStack, contextmanager
48: get_async_callback_manager_for_config,
49: get_callback_manager_for_config,
105: @contextmanager
401: callback_manager = get_callback_manager_for_config(config, self.tags)
402: run_manager = callback_manager.on_chain_start(
409: child_config = patch_config(config, callbacks=run_manager.get_child())
411: for h in run_manager.handlers:
### 12 libs/langgraph/langgraph/_internal/_config.py
9: AsyncCallbackManager,
10: BaseCallbackManager,
11: CallbackManager,
117: # callbacks can be either None, list[handler] or manager
125: # base_callbacks is a manager
130: elif isinstance(value, BaseCallbackManager):
131: # value is a manager
140: # base_callbacks is also a manager
### 12 libs/checkpoint-postgres/langgraph/checkpoint/postgres/shallow.py
5: from contextlib import asynccontextmanager, contextmanager
210: @contextmanager
486: @contextmanager
488: """Create a database cursor as a context manager.
491: pipeline: whether to use pipeline for the DB operations inside the context manager.
493: If pipeline mode is not supported, will fall back to using transaction context manager.
517: # Use connection's transaction context manager when pipeline mode not supported
570: @asynccontextmanager

## letta-ai__letta
### 54 letta/services/agent_manager.py
26: SUBAGENT_ROLE_TAG,
64: from letta.schemas.group import Group as PydanticGroup, ManagerType
76: from letta.services.archive_manager import ArchiveManager
77: from letta.services.block_manager import BlockManager
80: from letta.services.conversation_manager import ConversationManager
82: from letta.services.files_agents_manager import FileAgentManager
83: from letta.services.helpers.agent_manager_helper import (
103: from letta.services.identity_manager import IdentityManager
### 44 alembic/versions/9fa274fb0b83_backfill_hidden_for_subagent_role_tag.py
1: """backfill hidden for role:subagent agents
28: AND at.tag = 'role:subagent'
### 42 letta/schemas/group.py
11: class ManagerType(str, Enum):
13: supervisor = "supervisor"
17: swarm = "swarm"
20: class ManagerConfig(BaseModel):
21: manager_type: ManagerType = Field(..., description="")
30: manager_type: ManagerType = Field(..., description="")
40: manager_agent_id: Optional[str] = Field(None, description="")
60: def manager_config(self) -> ManagerConfig:
### 31 letta/constants.py
39: SUBAGENT_ROLE_TAG = "role:subagent"
### 25 tests/helpers/utils.py
86: agent_states = await server.agent_manager.list_agents_async(name=agent_uuid, actor=actor)
89: await server.agent_manager.delete_agent_async(agent_id=agent_state.id, actor=actor)
162: print("AGENTTOOLRULES", agent.tool_rules)
### 24 letta/services/agent_serialization_manager.py
42: from letta.services.agent_manager import AgentManager
43: from letta.services.block_manager import BlockManager
44: from letta.services.file_manager import FileManager
50: from letta.services.files_agents_manager import FileAgentManager
51: from letta.services.group_manager import GroupManager
52: from letta.services.mcp_manager import MCPManager
53: from letta.services.message_manager import MessageManager
54: from letta.services.source_manager import SourceManager
### 24 letta/server/rest_api/routers/v1/agents.py
63: from letta.services.run_manager import RunManager
184: actor = await server.user_manager.get_actor_or_default_async(actor_id=headers.actor_id)
193: return await server.agent_manager.list_agents_async(
245: actor = await server.user_manager.get_actor_or_default_async(actor_id=headers.actor_id)
269: return await server.agent_manager.size_async(actor=actor)
271: return await server.agent_manager.count_agents_async(
324: actor = await server.user_manager.get_actor_or_default_async(actor_id=headers.actor_id)
325: agent_file_schema = await server.agent_serialization_manager.export(
### 24 letta/schemas/agent_file.py
15: ManagerConfig,
16: ManagerType,
17: RoundRobinManager,
25: from letta.services.message_manager import MessageManager
146: cls, agent_state: AgentState, message_manager: MessageManager, files_agents: List[FileAgent], actor: User
197: messages = await message_manager.get_messages_by_ids_async(message_ids=agent_state.message_ids, actor=actor)
199: messages = await message_manager.list_messages(
210: messages=message_schemas,  # Messages will be populated separately by the manager
### 24 letta/groups/supervisor_multi_agent.py
7: from letta.services.agent_manager import AgentManager
8: from letta.services.tool_manager import ToolManager
11: class SupervisorMultiAgent(BaseAgent):
26: self.agent_manager = AgentManager()
27: self.tool_manager = ToolManager()
44: #        # Prepare supervisor agent
45: #        if self.tool_manager.get_tool_by_name(tool_name="send_message_to_all_agents_in_group", actor=self.user) is None:
55: #            multi_agent_tool = self.tool_manager.create_or_update_tool(
### 24 letta/groups/sleeptime_multi_agent_v4.py
10: from letta.schemas.group import Group, ManagerType
20: from letta.services.group_manager import GroupManager
32: assert group.manager_type == ManagerType.sleeptime, f"Expected group type to be 'sleeptime', got {group.manager_type}"
36: # Additional manager classes
37: self.group_manager = GroupManager()
141: turns_counter = await self.group_manager.bump_turns_counter_async(group_id=self.group.id, actor=self.actor)
152: last_processed_message_id = await self.group_manager.get_last_processed_message_id_and_update_async(
186: run = await self.run_manager.create_run(pydantic_run=run, actor=self.actor)

## mastra-ai__mastra
### 54 packages/server/src/server/handlers/agents.ts
2: import type { AgentModelManagerConfig, AgentSignalInput, DurableAgentLike } from '@mastra/core/agent';
232: Omit<AgentModelManagerConfig, 'model'> & {
257: export async function getSerializedAgentTools(
500: logger?.warn('Error getting sub-agents for agent', { agentName: agent.name, error });
577: const serializedAgentTools = await getSerializedAgentTools(tools, partial);
666: tools: serializedAgentTools,
744: logger.debug('Agent not found, looking through sub-agents', { agentId });
749: const subAgents = await ag.listAgents();
### 54 packages/memory/src/processors/observational-memory/__tests__/mock-om-agent.test.ts
399: it('should complete when primary agent with OM calls a sub-agent with OM', async () => {
400: const subAgent = new Agent({
401: id: 'sub-agent',
421: instructions: 'Use your sub-agent.',
423: agents: { researcher: subAgent },
450: // Sub-agent should have its own thread with a separate resourceId
451: const subAgentResourceId = 'test-resource-researcher';
452: let subAgentThreads = await memoryStore!.listThreads({
### 54 packages/core/src/loop/workflows/agentic-execution/tool-call-step.ts
187: const { saveQueueManager, memoryConfig, threadId } = _internal || {};
189: if (!saveQueueManager || !threadId) {
271: await saveQueueManager.flushMessages(messageList, threadId, memoryConfig);
281: const { saveQueueManager, memoryConfig, threadId, resourceId, memory } = _internal || {};
283: if (!saveQueueManager || !threadId) {
303: await saveQueueManager.flushMessages(messageList, threadId, memoryConfig);
459: // resumeStream instead of stream (otherwise the sub-agent restarts from scratch)
460: const isAgentTool = inputData.toolName?.startsWith('agent-');
### 54 packages/core/src/harness/subagent-workspace-integration.test.ts
10: import { createSubagentTool } from './tools';
11: import type { HarnessSubagent } from './types';
13: describe('subagent workspace tool integration', () => {
17: tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-ws-'));
36: it('subagent executes a workspace read_file tool against a real file', async () => {
91: const subagents: HarnessSubagent[] = [
101: const tool = createSubagentTool({
102: subagents,
### 54 packages/core/src/harness/subagent-tool.test.ts
30: import { createSubagentTool } from './tools';
31: import type { HarnessRequestContext, HarnessSubagent } from './types';
59: const subagents: HarnessSubagent[] = [
78: describe('createSubagentTool requestContext forwarding', () => {
87: it('does NOT append the internal `<subagent-meta />` tag to model-facing content (success path)', async () => {
93: const tool = createSubagentTool({
94: subagents,
106: expect(result.content).not.toContain('<subagent-meta');
### 54 packages/core/src/agent/subagent.ts
12: * Minimal interface for objects that can be used as subagents in the `agents` field.
14: * subagents without the full Agent class.
16: export type SubAgentToolResult = {
26: export type SubAgentGenerateResult = Pick<FullOutput, 'text' | 'finishReason' | 'runId'> & {
28: toolResults?: SubAgentToolResult[];
33: export type SubAgentStreamResult = {
38: toolResults?: SubAgentToolResult[] | Promise<SubAgentToolResult[]>;
42: export interface SubAgent<TId = string, TRequestContext extends Record<string, any> | unknown = unknown> {
### 54 packages/core/src/agent/durable/__tests__/durable-agent-background-tasks.test.ts
129: await mastra.backgroundTaskManager?.shutdown();
288: it('bg task completes and result is queryable via the task manager', async () => {
303: id: 'bg-pubsub-agent',
316: agents: { 'bg-pubsub-agent': durableAgent as any },
332: const manager = localMastra.backgroundTaskManager!;
333: const task = await manager.getTask(bgStarted.payload.taskId);
341: it('tool calling suspend via taskContext pauses the bg task; manager.resume completes it', async () => {
401: const manager = localMastra.backgroundTaskManager!;
### 54 packages/core/src/agent/agent.types.ts
44: * Contains everything needed to decide which parent messages to share with the sub-agent.
49: /** The ID of the primitive being delegated to */
51: /** The type of primitive being delegated to */
53: /** The prompt being sent to the sub-agent (after any onDelegationStart modifications) */
73: * Contains information about the sub-agent or workflow being called.
76: /** The ID of the delegated primitive (agent or workflow) */
78: /** The type of primitive being delegated to */
80: /** The prompt being sent to the sub-agent/workflow */
### 54 packages/core/src/agent/agent.ts
103: import { SaveQueueManager } from './save-queue';
105: import type { SubAgent } from './subagent';
114: AgentModelManagerConfig,
298: implements SubAgent<TAgentId, TRequestContext>
319: #agents: DynamicArgument<Record<string, SubAgent<string, TRequestContext>>, TRequestContext>;
443: this.#agents = config.agents || ({} as Record<string, SubAgent<string, TRequestContext>>);
549: * Returns the statically-configured sub-agents without executing dynamic
551: * tasks should be auto-enabled. Returns undefined when sub-agents are
### 54 packages/core/src/agent/agent-network.test.ts
134: // Create a sub-agent with a tool that will be called
147: // First call: select the sub-agent
149: primitiveId: 'subAgent',
152: selectionReason: 'Sub-agent can use the test tool',
159: completionReason: 'The sub-agent processed the request',
189: // Sub-agent mock that will "use" the tool
191: const subAgentMockModel = new MockLanguageModelV2({
221: const subAgent = new Agent({

## microsoft__autogen
### 54 python/packages/autogen-studio/frontend/src/components/views/teambuilder/builder/nodes.tsx
24: TeamConfig,
34: import { useTeamBuilderStore } from "./store";
37: isSelectorTeam,
38: isSwarmTeam,
49: team: Users,
115: const removeNode = useTeamBuilderStore((state) => state.removeNode);
116: const setSelectedNode = useTeamBuilderStore(
119: const showDelete = data.type !== "team";
### 54 python/packages/autogen-studio/frontend/src/components/views/teambuilder/builder/component-editor/fields/team-fields.tsx
6: TeamConfig,
10: SwarmConfig,
13: isSelectorTeam,
14: isRoundRobinTeam,
15: isSwarmTeam,
20: interface TeamFieldsProps {
21: component: Component<TeamConfig>;
26: export const TeamFields: React.FC<TeamFieldsProps> = ({
### 54 python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_swarm_group_chat.py
8: from ...messages import BaseAgentEvent, BaseChatMessage, HandoffMessage, MessageFactory
9: from ...state import SwarmManagerState
11: from ._base_group_chat_manager import BaseGroupChatManager
15: class SwarmGroupChatManager(BaseGroupChatManager):
16: """A group chat manager that selects the next speaker based on handoff message only."""
30: emit_team_events: bool,
43: emit_team_events,
49: # Check if any of the start messages is a handoff message.
### 54 python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_selector_group_chat.py
25: from ...base import ChatAgent, Team, TerminationCondition
29: HandoffMessage,
34: from ...state import SelectorManagerState
36: from ._base_group_chat_manager import BaseGroupChatManager
50: class SelectorGroupChatManager(BaseGroupChatManager):
51: """A group chat manager that selects the next speaker using a ChatCompletion
72: emit_team_events: bool,
87: emit_team_events,
### 54 python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_magentic_one/_magentic_one_orchestrator.py
21: HandoffMessage,
33: from .._base_group_chat_manager import BaseGroupChatManager
40: GroupChatTeamResponse,
58: class MagenticOneOrchestrator(BaseGroupChatManager):
76: emit_team_events: bool,
89: emit_team_events=emit_team_events,
101: # Produce a team description. Each agent sould appear on a single line.
102: self._team_description = ""
### 54 python/packages/autogen-agentchat/src/autogen_agentchat/conditions/_terminations.py
13: HandoffMessage,
309: class HandoffTerminationConfig(BaseModel):
313: class HandoffTermination(TerminationCondition, Component[HandoffTerminationConfig]):
314: """Terminate the conversation if a :class:`~autogen_agentchat.messages.HandoffMessage`
318: target (str): The target of the handoff message.
321: component_config_schema = HandoffTerminationConfig
322: component_provider_override = "autogen_agentchat.conditions.HandoffTermination"
336: if isinstance(message, HandoffMessage) and message.target == self._target:
### 54 python/packages/autogen-agentchat/src/autogen_agentchat/base/_handoff.py
12: class Handoff(BaseModel):
13: """Handoff configuration."""
16: """The name of the target agent to handoff to."""
19: """The description of the handoff such as the condition under which it should happen and the target agent's ability.
23: """The name of this handoff configuration. If not provided, it is generated from the target agent's name."""
27: By default, it will be the result for the handoff tool.
34: values["description"] = f"Handoff to {values['target']}."
36: values["name"] = f"transfer_to_{values['target']}".lower()
### 54 python/packages/autogen-agentchat/src/autogen_agentchat/agents/_user_proxy_agent.py
3: from contextlib import contextmanager
13: from ..messages import BaseAgentEvent, BaseChatMessage, HandoffMessage, TextMessage, UserInputRequestedEvent
44: Using :class:`UserProxyAgent` puts a running team in a temporary blocked
51: such as :class:`~autogen_agentchat.conditions.HandoffTermination` or :class:`~autogen_agentchat.conditions.SourceMatchTermination`
52: to stop the running team and return the control to the application.
53: You can run the team again with the user input. This way, the state of the team
142: @contextmanager
175: return (TextMessage, HandoffMessage)
### 54 python/packages/autogen-agentchat/src/autogen_agentchat/agents/_society_of_mind_agent.py
15: from ..base import TaskResult, Team
19: HandoffMessage,
30: team: ComponentModel
39: """An agent that uses an inner team of agents to generate responses.
42: method is called, it runs the inner team of agents and then uses the
43: model client to generate a response based on the inner team's messages.
44: Once the response is generated, the agent resets the inner team by
45: calling :meth:`Team.reset`.
### 54 python/packages/autogen-agentchat/src/autogen_agentchat/agents/_assistant_agent.py
43: from ..base import Handoff as HandoffBase
48: HandoffMessage,
77: handoffs: List[HandoffBase | str] | None = None
165: * If a handoff is triggered, a :class:`~autogen_agentchat.messages.HandoffMessage` will be returned in :attr:`~autogen_agentchat.base.Response.chat_message`.
166: * If there are tool calls, they will also be executed right away before returning the handoff.
167: * The tool calls and results are passed to the target agent through :attr:`~autogen_agentchat.messages.HandoffMessage.context`.
171: If multiple handoffs are detected, only the first handoff is executed.
200: handoffs (List[HandoffBase | str] | None, optional): The handoff configurations for the agent,

## microsoft__semantic-kernel
### 54 python/semantic_kernel/agents/orchestration/handoffs.py
52: # of the possible handoff connections for an agent.
53: AgentHandoffs = dict[str, str]
57: class OrchestrationHandoffs(dict[str, AgentHandoffs]):
58: """A dictionary mapping agent names to their handoff connections.
60: Handoff connections are represented as a dictionary where the key is the target agent name
61: and the value is a description of the handoff connection. For example:
73: This class allows for easy addition of handoff connections between agents.
77: """Add a handoff connection to the source agent.
### 54 python/samples/getting_started_with_agents/multi_agent_orchestration/step4c_handoff_mix_agent_types.py
17: HandoffOrchestration,
18: OrchestrationHandoffs,
27: The following sample replicates sample "step4_handoff.py" but uses different agent types.
34: The Handoff orchestration doesn't support the following agent types:
83: async def get_agents() -> tuple[list[Agent], OrchestrationHandoffs]:
84: """Return a list of agents that will participate in the Handoff orchestration and the handoff relationships.
86: Feel free to add or remove agents and handoff connections.
136: # Define the handoff relationships between agents
### 54 python/samples/getting_started_with_agents/multi_agent_orchestration/step4b_handoff_streaming_agent_response_callback.py
7: from semantic_kernel.agents import Agent, ChatCompletionAgent, HandoffOrchestration, OrchestrationHandoffs
20: The following sample demonstrates how to create a handoff orchestration that represents
31: orchestration. Except that in the handoff orchestration, all agents have access to the
32: human response function, whereas in the group chat orchestration, only the manager has access
36: a handoff orchestration, invoking the orchestration, and finally waiting for the results.
66: def get_agents() -> tuple[list[Agent], OrchestrationHandoffs]:
67: """Return a list of agents that will participate in the Handoff orchestration and the handoff relationships.
69: Feel free to add or remove agents and handoff connections.
### 54 python/samples/getting_started_with_agents/multi_agent_orchestration/step4a_handoff_structured_inputs.py
9: from semantic_kernel.agents import Agent, ChatCompletionAgent, HandoffOrchestration, OrchestrationHandoffs
16: The following sample demonstrates how to create a handoff orchestration that can triage
26: a handoff orchestration, invoking the orchestration, and finally waiting for the results.
73: def get_agents() -> tuple[list[Agent], OrchestrationHandoffs]:
74: """Return a list of agents that will participate in the Handoff orchestration and the handoff relationships.
76: Feel free to add or remove agents and handoff connections.
101: # Define the handoff relationships between agents
102: handoffs = {
### 54 python/samples/getting_started_with_agents/multi_agent_orchestration/step4_handoff.py
7: from semantic_kernel.agents import Agent, ChatCompletionAgent, HandoffOrchestration, OrchestrationHandoffs
14: The following sample demonstrates how to create a handoff orchestration that represents
22: orchestration. Except that in the handoff orchestration, all agents have access to the
23: human response function, whereas in the group chat orchestration, only the manager has access
27: a handoff orchestration, invoking the orchestration, and finally waiting for the results.
57: def get_agents() -> tuple[list[Agent], OrchestrationHandoffs]:
58: """Return a list of agents that will participate in the Handoff orchestration and the handoff relationships.
60: Feel free to add or remove agents and handoff connections.
### 54 dotnet/src/Agents/Orchestration/Handoff/Handoffs.cs
6: namespace Microsoft.SemanticKernel.Agents.Orchestration.Handoff;
9: /// Defines the handoff relationships for a given agent.
10: /// Maps target agent names/IDs to handoff descriptions.
12: public sealed class AgentHandoffs : Dictionary<string, string>
15: /// Initializes a new instance of the <see cref="AgentHandoffs"/> class with no handoff relationships.
17: public AgentHandoffs() { }
20: /// Initializes a new instance of the <see cref="AgentHandoffs"/> class with the specified handoff relationships.
22: /// <param name="handoffs">A dictionary mapping target agent names/IDs to handoff descriptions.</param>
### 54 dotnet/src/Agents/Orchestration/Handoff/HandoffOrchestration.cs
11: namespace Microsoft.SemanticKernel.Agents.Orchestration.Handoff;
15: /// and Handoffly passes each agent result to the next agent.
17: public class HandoffOrchestration<TInput, TOutput> : AgentOrchestration<TInput, TOutput>
19: private readonly OrchestrationHandoffs _handoffs;
22: /// Initializes a new instance of the <see cref="HandoffOrchestration{TInput, TOutput}"/> class.
24: /// <param name="handoffs">Defines the handoff connections for each agent.</param>
26: public HandoffOrchestration(OrchestrationHandoffs handoffs, params Agent[] agents)
32: handoffs.FirstAgentName
### 54 dotnet/src/Agents/Orchestration/Handoff/HandoffActor.cs
12: namespace Microsoft.SemanticKernel.Agents.Orchestration.Handoff;
15: /// An actor used with the <see cref="HandoffOrchestration{TInput,TOutput}"/>.
17: internal sealed class HandoffActor :
19: IHandle<HandoffMessages.InputTask>,
20: IHandle<HandoffMessages.Request>,
21: IHandle<HandoffMessages.Response>
23: private readonly HandoffLookup _handoffs;
24: private readonly AgentType _resultHandoff;
### 54 dotnet/src/Agents/AzureAI/Extensions/AgentToolDefinitionExtensions.cs
11: /// Provides extension methods for <see cref="AgentToolDefinition"/>.
13: internal static class AgentToolDefinitionExtensions
15: internal static AzureFunctionBinding GetInputBinding(this AgentToolDefinition agentToolDefinition)
17: return agentToolDefinition.GetAzureFunctionBinding("input_binding");
20: internal static AzureFunctionBinding GetOutputBinding(this AgentToolDefinition agentToolDefinition)
22: return agentToolDefinition.GetAzureFunctionBinding("output_binding");
25: internal static BinaryData GetParameters(this AgentToolDefinition agentToolDefinition)
27: var parameters = agentToolDefinition.GetOption<List<object>?>("parameters");
### 54 dotnet/samples/AgentFrameworkMigration/AgentOrchestrations/Step03_Handoff/Program.cs
3: #pragma warning disable MAAIW001 // Experimental: HandoffWorkflowBuilder
15: using Microsoft.SemanticKernel.Agents.Orchestration.Handoff;
28: // This sample compares running handoff orchestrations using
30: Console.WriteLine("=== Semantic Kernel Handoff Orchestration ===");
34: await SKHandoffOrchestration();
36: Console.WriteLine("\n=== Agent Framework Handoff Agent Workflow ===");
37: await AFHandoffAgentWorkflow();
39: # region SKHandoffOrchestration

## openai__codex
### 54 codex-rs/tui/src/multi_agents.rs
12: use codex_app_server_protocol::CollabAgentTool;
13: use codex_app_server_protocol::CollabAgentToolCallStatus;
178: ThreadItem::CollabAgentToolCall {
179: tool: CollabAgentTool::SpawnAgent,
196: let ThreadItem::CollabAgentToolCall {
214: CollabAgentTool::SpawnAgent => {
215: if matches!(status, CollabAgentToolCallStatus::InProgress) {
227: CollabAgentTool::SendInput => {
### 54 codex-rs/external-agent-migration/src/lib.rs
134: pub fn count_missing_subagents(source_agents: &Path, target_agents: &Path) -> io::Result<usize> {
135: Ok(missing_subagent_names(source_agents, target_agents)?.len())
138: pub fn missing_subagent_names(
148: let Some(target) = subagent_target_file(&source_file, target_agents) else {
158: pub fn import_subagents(source_agents: &Path, target_agents: &Path) -> io::Result<usize> {
166: let Some(target) = subagent_target_file(&source_file, target_agents) else {
594: if ["asyncRewake", "shell", "once"]
911: fn subagent_target_file(source_file: &Path, target_agents: &Path) -> Option<PathBuf> {
### 54 codex-rs/core/src/tools/handlers/multi_agents_tests.rs
2: use crate::ThreadManager;
8: use crate::session_prefix::format_subagent_notification_message;
9: use crate::thread_manager::thread_store_from_config;
20: use codex_login::AuthManager;
50: use codex_protocol::protocol::SubAgentSource;
95: fn thread_manager() -> ThreadManager {
96: ThreadManager::with_models_provider_for_tests(
246: let manager = thread_manager();
### 54 codex-rs/core/src/tools/handlers/multi_agents_spec.rs
15: pub struct SpawnAgentToolOptions {
41: pub fn create_spawn_agent_tool_v1(options: SpawnAgentToolOptions) -> ToolSpec {
66: pub fn create_spawn_agent_tool_v2(options: SpawnAgentToolOptions) -> ToolSpec {
616: Spawn a sub-agent for a well-scoped task. {return_value_description} {SPAWN_AGENT_INHERITED_MODEL_GUIDANCE}"#
637: This spawn_agent tool provides you access to sub-agents that inherit your current model by default. Do not set the `model` field unless the user explicitly asks for a different model or there is a clear task-specific rea
639: Only use `spawn_agent` if and only if the user explicitly asks for sub-agents, delegation, or parallel agent work.
643: ### When to delegate vs. do the subtask yourself
645: - Use a subagent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task without blocking your 
### 54 codex-rs/core/src/tools/handlers/multi_agents_common.rs
12: use codex_models_manager::manager::RefreshStrategy;
24: use codex_protocol::protocol::SubAgentSource;
115: CodexErr::UnsupportedOperation(message) if message == "thread manager dropped" => {
116: FunctionCallError::RespondToModel("collab manager unavailable".to_string())
132: FunctionCallError::RespondToModel("collab manager unavailable".to_string())
155: Ok(SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
198: /// Builds the base config snapshot for a newly spawned sub-agent.
304: .models_manager
### 54 codex-rs/core/src/codex_delegate.rs
17: use codex_protocol::protocol::SubAgentSource;
48: use crate::session::emit_subagent_session_started;
51: use codex_login::AuthManager;
52: use codex_models_manager::manager::SharedModelsManager;
61: /// The returned `events_rx` yields non-approval events emitted by the sub-agent.
63: /// The returned `ops_tx` allows the caller to submit additional `Op`s to the sub-agent.
67: auth_manager: Arc<AuthManager>,
68: models_manager: SharedModelsManager,
### 54 codex-rs/core/src/agent/control_tests.rs
4: use crate::ThreadManager;
10: use crate::context::SubagentNotification;
24: use codex_protocol::protocol::SubAgentSource;
90: manager: ThreadManager,
98: let manager = ThreadManager::with_models_provider_home_and_state_for_tests(
102: std::sync::Arc::new(codex_exec_server::EnvironmentManager::default_for_tests()),
105: let control = manager.agent_control();
110: manager,
### 54 codex-rs/core/src/agent/control.rs
8: use crate::session::emit_subagent_session_started;
9: use crate::session_prefix::format_subagent_context_line;
10: use crate::session_prefix::format_subagent_notification_message;
12: use crate::thread_manager::ResumeThreadWithHistoryOptions;
13: use crate::thread_manager::ThreadManagerState;
30: use codex_protocol::protocol::SubAgentSource;
134: /// tree. That same `AgentControl` is then shared with every sub-agent spawned from that root,
135: /// which keeps the registry scoped to that root thread rather than the entire `ThreadManager`.
### 54 codex-rs/app-server/src/request_processors/external_agent_config_processor.rs
9: use crate::config_manager::ConfigManager;
30: use codex_core::ThreadManager;
52: thread_manager: Arc<ThreadManager>,
53: config_manager: ConfigManager,
61: thread_manager: Arc<ThreadManager>,
62: config_manager: ConfigManager,
72: thread_manager,
73: config_manager,
### 54 codex-rs/app-server/src/config/external_agent_config_tests.rs
296: async fn detect_repo_lists_mcp_hooks_commands_and_subagents() {
334: .expect("write subagent");
399: item_type: ExternalAgentConfigMigrationItemType::Subagents,
401: "Migrate subagents from {} to {}",
407: subagents: vec![NamedMigration {
425: r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","if":"Bash(rm *)","command":"echo blocked"}]}],"SubagentStart":[{"matcher":"worker","hooks":[{"type":"command","command":"echo started"}]}]}}"#,
444: async fn import_repo_migrates_mcp_hooks_commands_and_subagents() {
472: "X-Team": "${TEAM}"

## openai__swarm
### 45 swarm/repl/repl.py
3: from swarm import Swarm
63: client = Swarm()
64: print("Starting Swarm CLI 🐝")
### 45 examples/airline/configs/agents.py
6: from swarm import Agent
9: def transfer_to_flight_modification():
13: def transfer_to_flight_cancel():
17: def transfer_to_flight_change():
21: def transfer_to_lost_baggage():
25: def transfer_to_triage():
46: functions=[transfer_to_flight_modification, transfer_to_lost_baggage],
55: functions=[transfer_to_flight_cancel, transfer_to_flight_change],
### 44 swarm/__init__.py
1: from .core import Swarm
4: __all__ = ["Swarm", "Agent", "Response"]
### 43 swarm/core.py
26: class Swarm:
### 41 examples/customer_service_streaming/src/swarm/engines/assistants_engine.py
7: from src.swarm.assistants import Assistant
106: Analyze the user message and delegate it to the appropriate assistant.
305: #Initialize swarm first
308: print("\nTesting the swarm\n\n")
311: print("\n🐝🐝🐝 Deploying the swarm 🐝🐝🐝\n\n")
340: print("Completed testing the swarm\n\n")
342: print("🍯🐝🍯 Swarm operations complete 🍯🐝🍯\n\n")
### 40 examples/customer_service_streaming/src/swarm/engines/local_engine.py
7: from src.swarm.assistants import Assistant
8: from src.swarm.tool import Tool
95: Analyze the user message and delegate it to the appropriate assistant.
351: print("Completed testing the swarm\n\n")
359: print("\nTesting the swarm\n\n")
367: print("\n🐝🐝🐝 Deploying the swarm 🐝🐝🐝\n\n")
### 39 examples/triage_agent/evals.py
1: from swarm import Swarm
7: client = Swarm()
40: ("I want to make a refund!", "transfer_to_refunds"),
41: ("I want to talk to sales.", "transfer_to_sales"),
62: {"role": "tool", "tool_name": "transfer_to_refunds"},
### 39 examples/customer_service_streaming/src/swarm/swarm.py
4: from src.swarm.engines.assistants_engine import AssistantsEngine
5: from src.swarm.engines.local_engine import LocalEngine
8: # This class represents the main control unit for deploying and managing tasks within the swarm system.
11: class Swarm:
23: # Initialize swarm first
### 38 examples/triage_agent/agents.py
1: from swarm import Agent
36: def transfer_to_sales():
40: def transfer_to_refunds():
44: triage_agent.functions = [transfer_to_sales, transfer_to_refunds]
### 38 examples/basic/agent_handoff.py
1: from swarm import Swarm, Agent
3: client = Swarm()
16: def transfer_to_spanish_agent():
21: english_agent.functions.append(transfer_to_spanish_agent)

## pydantic__pydantic-ai
### 54 pydantic_ai_slim/pydantic_ai/agent/__init__.py
10: from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager, contextmanager
58: from ..tool_manager import ParallelExecutionMode, ToolManager
77: from ..toolsets import AbstractToolset, AgentToolset
246: toolsets: Sequence[AgentToolset[AgentDepsT]] | None = None,
298: toolsets: Sequence[AgentToolset[AgentDepsT]] | None = None,
495: self._cap_toolsets: list[AgentToolset[AgentDepsT]] = [cap_toolset] if cap_toolset is not None else []
549: toolsets: Sequence[AgentToolset[Any]] | None = None,
577: toolsets: Sequence[AgentToolset[Any]] | None = None,
### 42 pydantic_ai_slim/pydantic_ai/common_tools/image_generation.py
31: 'ImageGenerationSubagentTool',
36: # required by the subagent fallback, mapped to suggested LLM alternatives.
61: class ImageGenerationSubagentTool:
62: """Local image generation tool that delegates to a subagent.
64: Uses a subagent with the specified model and builtin tool configuration
73: """The image generation tool configuration to pass to the subagent."""
76: """Instructions for the subagent that generates the image."""
79: """Generate an image using a subagent.
### 37 pydantic_ai_slim/pydantic_ai/capabilities/abstract.py
23: from pydantic_ai.toolsets import AbstractToolset, AgentToolset
172: # its `get_builtin_tools` with a stub that warns and delegates to the modern
198: to delegate to the wrapped capability.
273: def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
325: parameters and `ToolManager.tools`, so filtering also blocks tool execution.
341: parameters and `ToolManager.tools`, so filtering also blocks tool execution.
872: Called by [`ToolManager`][pydantic_ai.tool_manager.ToolManager] when:
### 36 examples/pydantic_ai_examples/medical_agent_delegation.py
5: It delegates the actual medical work (diagnosis or treatment planning) to other agents.
16: - Master agent coordinating specialized sub-agents
### 34 tests/test_native_tools_deprecation.py
904: delegate to `Child.supported_native_tools()` instead of resolving to the parent's
1096: def test_image_generation_subagent_tool_builtin_tool_constructor_deprecated():
1097: """`ImageGenerationSubagentTool(builtin_tool=...)` warns and routes to `native_tool=`."""
1098: from pydantic_ai.common_tools.image_generation import ImageGenerationSubagentTool
1105: match=r'`ImageGenerationSubagentTool\(builtin_tool=\.\.\.\)` is deprecated, use `native_tool=`',
1107: subagent = ImageGenerationSubagentTool(
1111: assert subagent.native_tool is legacy_tool
1114: def test_image_generation_subagent_tool_builtin_tool_attribute_deprecated():
### 34 pydantic_ai_slim/pydantic_ai/capabilities/image_generation.py
26: delegates to a subagent running the specified image-capable model.
30: both the native and the local fallback subagent. When passing a custom `native`
31: instance, its settings are also used for the fallback subagent; capability-level
139: 'use `fallback_model` for the default subagent fallback, or `local` for a custom tool'
### 33 pydantic_ai_slim/pydantic_ai/capabilities/wrapper.py
20: from pydantic_ai.toolsets import AbstractToolset, AgentToolset
47: """A capability that wraps another capability and delegates all methods.
87: def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
### 33 pydantic_ai_slim/pydantic_ai/capabilities/toolset.py
4: from pydantic_ai.toolsets import AgentToolset
13: toolset: AgentToolset[AgentDepsT]
19: def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
### 33 pydantic_ai_slim/pydantic_ai/capabilities/prefix_tools.py
8: from pydantic_ai.toolsets import AbstractToolset, AgentToolset
59: def get_toolset(self) -> AgentToolset[AgentDepsT] | None:
66: # ToolsetFunc callable — wrap in DynamicToolset so PrefixedToolset can delegate
### 32 pydantic_ai_slim/pydantic_ai/toolsets/__init__.py
19: AgentToolset = Union[AbstractToolset[AgentDepsT], ToolsetFunc[AgentDepsT]]  # noqa: UP007 — Union needed at runtime (no future annotations)
24: 'AgentToolset',

## run-llama__llama_index
### 54 llama-index-core/llama_index/core/agent/workflow/multi_agent_workflow.py
31: DEFAULT_HANDOFF_PROMPT,
32: DEFAULT_HANDOFF_OUTPUT_PROMPT,
72: async def handoff(ctx: Context, to_agent: str, reason: str) -> str:
73: """Handoff control of that chat to the given agent."""
76: can_handoff_to: dict[str, list[str]] = await ctx.store.get("can_handoff_to")
81: if can_handoff_to.get(
83: ) is not None and to_agent not in can_handoff_to.get(current_agent_name, []):
87: handoff_output_prompt = await ctx.store.get(
### 53 llama-index-core/llama_index/core/agent/workflow/codeact_agent.py
91: can_handoff_to: Optional[List[str]] = None,
118: can_handoff_to=can_handoff_to,
130: tool.metadata.name == "handoff"
202: if any(tool.metadata.name == "handoff" for tool in tools):
204: raise ValueError("llm must be a function calling LLM to use handoff")
206: tools = [tool for tool in tools if tool.metadata.name == "handoff"]
219: if any(tool.metadata.name == "handoff" for tool in tools):
221: raise ValueError("llm must be a function calling LLM to use handoff")
### 51 llama-index-core/llama_index/core/agent/workflow/base_agent.py
72: "service_manager",
73: "resource_manager",
108: can_handoff_to: Optional[List[str]] = Field(
150: can_handoff_to: Optional[List[str]] = None,
182: can_handoff_to=can_handoff_to,
200: Explicitly delegates to Workflow.validate to resolve the method conflict
226: if tool.metadata.name == "handoff":
228: "'handoff' is a reserved tool name. Please use a different name."
### 46 llama-index-core/tests/agent/workflow/test_function_call.py
68: async def test_aggregate_tool_results_return_direct_non_handoff_no_error_stops(
72: Test that when return_direct tool is NOT 'handoff' and has NO error,
85: tool_name="direct_tool",  # NOT 'handoff'
117: async def test_aggregate_tool_results_return_direct_handoff_does_not_stop(
121: Test that when return_direct tool is 'handoff',
127: tool_name="handoff",
129: raw_output="handoff_success",
133: handoff_tool = ToolCallResult(
### 45 llama-index-core/llama_index/core/instrumentation/events/agent.py
115: class AgentToolCallEvent(BaseEvent):
117: AgentToolCallEvent.
131: return "AgentToolCallEvent"
### 44 llama-index-integrations/callbacks/llama-index-callbacks-agentops/llama_index/callbacks/agentops/base.py
13: AgentToolCallEvent,
221: elif isinstance(event, AgentToolCallEvent):
### 44 llama-index-core/tests/agent/workflow/test_multi_agent_workflow.py
108: tool_name="handoff",
183: """Test basic workflow execution with agent handoff."""
198: # Verify we got events indicating handoff and calculation
216: """Test basic workflow execution with agent handoff."""
235: async def test_workflow_handoff_empty(calculator_agent, empty_retriever_agent):
236: """Test basic workflow execution with agent handoff."""
254: async def test_invalid_handoff():
255: """Test handling of invalid agent handoff."""
### 44 llama-index-core/llama_index/core/agent/workflow/react_agent.py
227: # add to reasoning if not a handoff
280: and tool_call_result.tool_name != "handoff"
### 44 llama-index-core/llama_index/core/agent/workflow/prompts.py
1: DEFAULT_HANDOFF_PROMPT = """Useful for handing off to another agent.
15: DEFAULT_HANDOFF_OUTPUT_PROMPT = "Agent {to_agent} is now handling the request due to the following reason: {reason}.\nPlease continue with the current request."
### 44 llama-index-core/llama_index/core/agent/workflow/function_agent.py
132: # only add to scratchpad if we didn't select the handoff tool
167: and tool_call_result.tool_name != "handoff"
