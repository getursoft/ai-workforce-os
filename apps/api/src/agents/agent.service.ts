import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  RequestTimeoutException
} from "@nestjs/common";
import {
  AgentExecutionStatus,
  AgentMemoryScope,
  AgentToolExecutionStatus,
  ConversationMessageRole,
  ConversationStatus,
  PluginStatus,
  Prisma
} from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import { AuthorizationService } from "../identity/application/services/authorization.service";
import { AgentRunDto, PageDto, SaveMemoryDto, SearchMemoryDto, UpdateMemoryDto } from "./agent.dto";
import {
  PromptBuilder,
  ToolExecutor,
  ToolPermissionPolicy,
  ToolRegistry,
  estimateCost,
  redact,
  type ModelMessage,
  withTimeout
} from "./agent.runtime";
import { AiProviderError, type ProviderSettings } from "../plugins/plugin-ai.runtime";
import { PluginAiService } from "../plugins/plugin-ai.service";

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService) {}
  async save(organizationId: string, userId: string, input: SaveMemoryDto) {
    await this.assertScope(organizationId, userId, input);
    const conversationId =
      input.scope === AgentMemoryScope.CONVERSATION ? (input.conversationId ?? null) : null;
    const where = {
      organizationId,
      pluginInstallationId: input.pluginInstallationId,
      userId: input.scope === AgentMemoryScope.USER ? userId : null,
      conversationId,
      scope: input.scope,
      key: input.key,
      deletedAt: null
    };
    const existing = await this.prisma.agentMemory.findFirst({ where });
    const data = {
      value: input.value as Prisma.InputJsonValue,
      searchableText: input.searchableText ?? JSON.stringify(input.value).slice(0, 2000),
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      deletedAt: null
    };
    return existing
      ? this.prisma.agentMemory.update({ where: { id: existing.id }, data })
      : this.prisma.agentMemory.create({
          data: {
            organizationId,
            pluginInstallationId: input.pluginInstallationId,
            userId: input.scope === AgentMemoryScope.USER ? userId : null,
            conversationId,
            scope: input.scope,
            key: input.key,
            ...data
          }
        });
  }
  async search(organizationId: string, userId: string, input: SearchMemoryDto) {
    await this.assertPlugin(organizationId, input.pluginInstallationId);
    return this.prisma.agentMemory.findMany({
      where: {
        organizationId,
        pluginInstallationId: input.pluginInstallationId,
        deletedAt: null,
        AND: [
          {
            OR: [
              { userId },
              {
                userId: null,
                scope: { in: [AgentMemoryScope.PLUGIN, AgentMemoryScope.ORGANIZATION] }
              }
            ]
          },
          {
            OR: [
              { key: { contains: input.query, mode: "insensitive" } },
              { searchableText: { contains: input.query, mode: "insensitive" } }
            ]
          }
        ]
      },
      orderBy: { updatedAt: "desc" },
      take: input.limit
    });
  }
  async list(organizationId: string, userId: string, page: PageDto) {
    const where: Prisma.AgentMemoryWhereInput = {
      organizationId,
      deletedAt: null,
      OR: [{ userId }, { userId: null }]
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentMemory.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      }),
      this.prisma.agentMemory.count({ where })
    ]);
    return paged(items, total, page);
  }
  async update(organizationId: string, userId: string, id: string, dto: UpdateMemoryDto) {
    const memory = await this.prisma.agentMemory.findFirst({
      where: { id, organizationId, deletedAt: null, OR: [{ userId }, { userId: null }] }
    });
    if (!memory) throw new NotFoundException("MEMORY_NOT_FOUND");
    return this.prisma.agentMemory.update({
      where: { id },
      data: {
        value: dto.value as Prisma.InputJsonValue,
        ...(dto.searchableText !== undefined ? { searchableText: dto.searchableText } : {}),
        ...(dto.metadata !== undefined ? { metadata: dto.metadata as Prisma.InputJsonValue } : {})
      }
    });
  }
  async forget(organizationId: string, userId: string, id: string): Promise<void> {
    const memory = await this.prisma.agentMemory.findFirst({
      where: { id, organizationId, deletedAt: null, OR: [{ userId }, { userId: null }] }
    });
    if (!memory) throw new NotFoundException("MEMORY_NOT_FOUND");
    await this.prisma.agentMemory.update({ where: { id }, data: { deletedAt: new Date() } });
  }
  private async assertScope(organizationId: string, userId: string, input: SaveMemoryDto) {
    await this.assertPlugin(organizationId, input.pluginInstallationId);
    if (input.scope === AgentMemoryScope.CONVERSATION) {
      if (!input.conversationId) throw new ConflictException("MEMORY_SCOPE_INVALID");
      const count = await this.prisma.conversation.count({
        where: {
          id: input.conversationId,
          organizationId,
          pluginInstallationId: input.pluginInstallationId,
          deletedAt: null
        }
      });
      if (!count) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    }
    if (input.scope === AgentMemoryScope.USER && !userId)
      throw new ForbiddenException("MEMORY_SCOPE_DENIED");
  }
  private async assertPlugin(organizationId: string, id: string) {
    if (!(await this.prisma.plugin.count({ where: { id, organizationId, deletedAt: null } })))
      throw new NotFoundException("PLUGIN_INSTALLATION_NOT_FOUND");
  }
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly tools = new ToolRegistry();
  private readonly executor: ToolExecutor;
  private readonly prompt = new PromptBuilder();
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly memories: MemoryService,
    private readonly pluginAi: PluginAiService
  ) {
    this.executor = new ToolExecutor(this.tools, new ToolPermissionPolicy());
    this.registerTools();
  }
  async run(organizationId: string, userId: string, requestId: string, dto: AgentRunDto) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: dto.pluginInstallationId, organizationId, deletedAt: null }
    });
    if (!plugin) throw new NotFoundException("PLUGIN_INSTALLATION_NOT_FOUND");
    if (plugin.status !== PluginStatus.ACTIVE) throw new ConflictException("PLUGIN_DISABLED");
    const { provider, settings } = await this.pluginAi.resolveProvider(
      organizationId,
      plugin.id
    );
    const configuredModel = providerModel(settings);
    const conversation = dto.conversationId
      ? await this.prisma.conversation.findFirst({
          where: {
            id: dto.conversationId,
            organizationId,
            pluginInstallationId: plugin.id,
            deletedAt: null
          }
        })
      : await this.prisma.conversation.create({
          data: {
            organizationId,
            pluginInstallationId: plugin.id,
            createdByUserId: userId,
            title: title(dto.message),
            metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue
          }
        });
    if (!conversation) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    if (conversation.status === ConversationStatus.ARCHIVED)
      throw new ConflictException("CONVERSATION_ARCHIVED");
    const historyRows = await this.prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id, organizationId },
      orderBy: { createdAt: "asc" },
      take: 30
    });
    await this.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        organizationId,
        role: ConversationMessageRole.USER,
        content: dto.message
      }
    });
    const execution = await this.prisma.agentExecution.create({
      data: {
        organizationId,
        conversationId: conversation.id,
        pluginInstallationId: plugin.id,
        userId,
        status: AgentExecutionStatus.RUNNING,
        modelProvider: providerName(settings),
        model: configuredModel,
        requestId,
        metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
        startedAt: new Date()
      }
    });
    const started = Date.now();
    let failureStage: "prompt" | "provider_call" | "response_parse" | "tool_loop" | "persistence" =
      "prompt";
    try {
      const permissions = new Set(
        await this.authorization.getEffectivePermissions(userId, organizationId)
      );
      const grants = new Set(
        Array.isArray(plugin.grantedPermissions)
          ? plugin.grantedPermissions.filter((x): x is string => typeof x === "string")
          : []
      );
      const available = new Set<string>(["platform.demo.echo"]);
      if (grants.has("MEMORY")) {
        available.add("platform.memory.save");
        available.add("platform.memory.search");
      }
      const recentMemories = await this.memories.search(organizationId, userId, {
        pluginInstallationId: plugin.id,
        query: "preference",
        limit: 10
      });
      let request = this.prompt.build({
        pluginPrompt: plugin.description,
        memories: recentMemories.map((x) => `${x.key}: ${x.searchableText ?? "configured"}`),
        history: historyRows.map(toModelMessage),
        message: dto.message,
        tools: this.tools.definitions(available)
      });
      let inputTokens = 0,
        outputTokens = 0,
        finalText = "",
        responseModel = configuredModel,
        responseProvider = providerName(settings);
      for (let iteration = 0; iteration < 4; iteration++) {
        failureStage = "provider_call";
        const response = await withTimeout(
          provider.complete({
            messages: request.messages,
            tools: request.tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema
            })),
            maxOutputTokens: 1000
          }),
          settings.timeoutMs + 1_000,
          "MODEL_EXECUTION_TIMEOUT"
        );
        inputTokens += response.usage?.inputTokens ?? 0;
        outputTokens += response.usage?.outputTokens ?? 0;
        responseModel = response.model;
        responseProvider = response.provider;
        if (!response.toolCalls.length) {
          finalText = response.content;
          break;
        }
        failureStage = "tool_loop";
        if (response.toolCalls.length > 5) throw new Error("AGENT_TOOL_LIMIT_EXCEEDED");
        for (const call of response.toolCalls) {
          const handler = this.tools.get(call.name);
          const row = await this.prisma.agentToolExecution.create({
            data: {
              organizationId,
              executionId: execution.id,
              toolName: call.name,
              toolVersion: handler.definition.version,
              status: AgentToolExecutionStatus.RUNNING,
              input: redact(
                call.arguments,
                handler.definition.sensitiveInputPaths
              ) as Prisma.InputJsonValue,
              startedAt: new Date()
            }
          });
          const toolStarted = Date.now();
          try {
            const output = await this.executor.execute(
              call.name,
              call.arguments,
              {
                organizationId,
                userId,
                pluginInstallationId: plugin.id,
                conversationId: conversation.id
              },
              available,
              permissions
            );
            await this.prisma.agentToolExecution.update({
              where: { id: row.id },
              data: {
                status: AgentToolExecutionStatus.COMPLETED,
                output: redact(
                  output,
                  handler.definition.sensitiveOutputPaths
                ) as Prisma.InputJsonValue,
                completedAt: new Date(),
                latencyMs: Date.now() - toolStarted
              }
            });
            const content = JSON.stringify(output).slice(0, 12_000);
            await this.prisma.conversationMessage.create({
              data: {
                conversationId: conversation.id,
                organizationId,
                toolExecutionId: row.id,
                role: ConversationMessageRole.TOOL,
                content,
                contentJson: redact(output) as Prisma.InputJsonValue
              }
            });
            request = {
              ...request,
              messages: [
                ...request.messages,
                { role: "assistant", content: "", toolCallId: call.id },
                { role: "tool", content, toolCallId: call.id }
              ]
            };
          } catch (error) {
            const code = safeCode(error);
            await this.prisma.agentToolExecution.update({
              where: { id: row.id },
              data: {
                status:
                  code === "TOOL_NOT_PERMITTED"
                    ? AgentToolExecutionStatus.DENIED
                    : code === "TOOL_TIMEOUT"
                      ? AgentToolExecutionStatus.TIMED_OUT
                      : AgentToolExecutionStatus.FAILED,
                errorCode: code,
                errorMessage: "Tool execution failed",
                completedAt: new Date(),
                latencyMs: Date.now() - toolStarted
              }
            });
            throw error;
          }
        }
      }
      if (!finalText) throw new Error("AGENT_ITERATION_LIMIT_EXCEEDED");
      failureStage = "persistence";
      const assistant = await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          organizationId,
          role: ConversationMessageRole.ASSISTANT,
          content: finalText,
          model: responseModel,
          inputTokens,
          outputTokens
        }
      });
      const totalTokens = inputTokens + outputTokens;
      await this.prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: AgentExecutionStatus.COMPLETED,
          completedAt: new Date(),
          latencyMs: Date.now() - started,
          inputTokens,
          outputTokens,
          totalTokens,
          estimatedCost: estimateCost(
            responseProvider,
            responseModel,
            inputTokens,
            outputTokens,
            {}
          )
        }
      });
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() }
      });
      return {
        conversationId: conversation.id,
        executionId: execution.id,
        messageId: assistant.id,
        response: finalText,
        status: "COMPLETED" as const,
        model: responseModel,
        usage: { inputTokens, outputTokens, totalTokens, estimatedCost: null }
      };
    } catch (error) {
      const stage = error instanceof AiProviderError ? error.stage : failureStage;
      this.logger.error({
        event: "AGENT_EXECUTION_FAILED",
        executionId: execution.id,
        providerType: settings.providerType,
        model: configuredModel,
        stage,
        code: safeCode(error),
        ...(error instanceof AiProviderError && error.upstreamStatus
          ? { upstreamStatus: error.upstreamStatus }
          : {})
      });
      try {
        await this.prisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: safeCode(error).includes("TIMEOUT")
              ? AgentExecutionStatus.TIMED_OUT
              : AgentExecutionStatus.FAILED,
            completedAt: new Date(),
            latencyMs: Date.now() - started,
            errorCode: safeCode(error),
            errorMessage: "Agent execution failed"
          }
        });
      } catch {
        this.logger.error({
          event: "AGENT_EXECUTION_FAILURE_PERSIST_FAILED",
          executionId: execution.id,
          providerType: settings.providerType,
          model: configuredModel,
          stage: "persistence"
        });
      }
      if (error instanceof AiProviderError)
        throw new IdentityApplicationError(error.code, providerExecutionMessage(error.code));
      if (safeCode(error).includes("TIMEOUT")) throw new RequestTimeoutException(safeCode(error));
      if (safeCode(error) === "TOOL_NOT_PERMITTED")
        throw new ForbiddenException("TOOL_NOT_PERMITTED");
      throw new IdentityApplicationError(
        "AGENT_EXECUTION_FAILED",
        "The agent execution could not be completed safely."
      );
    }
  }
  async employees(organizationId: string) {
    const items = await this.prisma.plugin.findMany({
      where: { organizationId, status: PluginStatus.ACTIVE, deletedAt: null },
      select: {
        id: true,
        displayName: true,
        description: true,
        version: true,
        status: true,
        lastHealthStatus: true,
        grantedPermissions: true
      }
    });
    return items.map((item) => ({
      ...item,
      runtimeReady:
        item.status === PluginStatus.ACTIVE &&
        Array.isArray(item.grantedPermissions) &&
        item.grantedPermissions.includes("MEMORY")
    }));
  }
  async conversations(organizationId: string, page: PageDto) {
    const where: Prisma.ConversationWhereInput = {
      organizationId,
      deletedAt: null,
      ...(page.pluginInstallationId ? { pluginInstallationId: page.pluginInstallationId } : {}),
      ...(page.status ? { status: page.status } : {}),
      ...(page.search ? { title: { contains: page.search, mode: "insensitive" } } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where,
        include: {
          pluginInstallation: { select: { displayName: true } },
          createdBy: { select: { firstName: true, lastName: true } },
          _count: { select: { messages: true } }
        },
        orderBy: { updatedAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      }),
      this.prisma.conversation.count({ where })
    ]);
    return paged(items, total, page);
  }
  async conversation(organizationId: string, id: string) {
    const value = await this.prisma.conversation.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: {
        pluginInstallation: { select: { displayName: true } },
        createdBy: { select: { firstName: true, lastName: true } },
        _count: { select: { messages: true } }
      }
    });
    if (!value) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    return value;
  }
  async messages(organizationId: string, id: string) {
    await this.conversation(organizationId, id);
    return this.prisma.conversationMessage.findMany({
      where: { conversationId: id, organizationId },
      orderBy: { createdAt: "asc" }
    });
  }
  async archive(organizationId: string, id: string, status: ConversationStatus) {
    await this.conversation(organizationId, id);
    return this.prisma.conversation.update({ where: { id }, data: { status } });
  }
  async executions(organizationId: string, page: PageDto) {
    const where = { organizationId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentExecution.findMany({
        where,
        include: {
          pluginInstallation: { select: { displayName: true } },
          user: { select: { firstName: true, lastName: true } },
          _count: { select: { toolExecutions: true } }
        },
        orderBy: { createdAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      }),
      this.prisma.agentExecution.count({ where })
    ]);
    return paged(items, total, page);
  }
  async execution(organizationId: string, id: string) {
    const value = await this.prisma.agentExecution.findFirst({
      where: { id, organizationId },
      include: {
        pluginInstallation: { select: { displayName: true } },
        user: { select: { firstName: true, lastName: true } },
        toolExecutions: { orderBy: { createdAt: "asc" } }
      }
    });
    if (!value) throw new NotFoundException("EXECUTION_NOT_FOUND");
    return value;
  }
  private registerTools() {
    this.tools.register({
      definition: {
        name: "platform.memory.save",
        version: "1.0.0",
        description: "Save a scoped preference",
        requiredPermissions: ["agents.memory.write"],
        timeoutMs: 3000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["key", "value", "scope"],
          properties: {
            key: { type: "string", minLength: 1, maxLength: 160 },
            value: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "object" }
              ]
            },
            scope: { enum: ["USER", "CONVERSATION", "PLUGIN"] }
          }
        }
      },
      execute: async (input, context) => {
        const value =
          typeof input.value === "object" && input.value !== null
            ? (input.value as Record<string, unknown>)
            : { value: input.value };
        const memory = await this.memories.save(context.organizationId, context.userId, {
          pluginInstallationId: context.pluginInstallationId,
          conversationId: context.conversationId,
          scope: input.scope as AgentMemoryScope,
          key: String(input.key),
          value,
          searchableText: String(input.value)
        });
        return { memoryId: memory.id, saved: true };
      }
    });
    this.tools.register({
      definition: {
        name: "platform.memory.search",
        version: "1.0.0",
        description: "Search scoped memories",
        requiredPermissions: ["agents.memory.read"],
        timeoutMs: 3000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1 },
            limit: { type: "integer", minimum: 1, maximum: 20 }
          }
        }
      },
      execute: async (input, context) =>
        (
          await this.memories.search(context.organizationId, context.userId, {
            pluginInstallationId: context.pluginInstallationId,
            query: String(input.query),
            limit: Number(input.limit ?? 10)
          })
        ).map((x) => ({ key: x.key, value: x.value }))
    });
    this.tools.register({
      definition: {
        name: "platform.demo.echo",
        version: "1.0.0",
        description: "Deterministic local echo",
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: 1000,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: { message: { type: "string", maxLength: 1000 } }
        }
      },
      execute: async (input) => ({ echo: input.message })
    });
  }
}

function toModelMessage(row: { role: ConversationMessageRole; content: string }): ModelMessage {
  return { role: row.role.toLowerCase() as ModelMessage["role"], content: row.content };
}
function title(message: string) {
  return message.trim().replace(/\s+/g, " ").slice(0, 80) || "New conversation";
}
function safeCode(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "AGENT_EXECUTION_FAILED";
}
function providerName(settings: ProviderSettings): string {
  if (settings.providerType === "OPENAI_COMPATIBLE") return "openai-compatible";
  if (settings.providerType === "AZURE_OPENAI") return "azure-openai";
  return "deterministic";
}
function providerModel(settings: ProviderSettings): string {
  if (settings.providerType === "AZURE_OPENAI")
    return settings.deploymentName ?? "unconfigured";
  if (settings.providerType === "OPENAI_COMPATIBLE") return settings.model ?? "unconfigured";
  return "travel-test-v1";
}
function providerExecutionMessage(code: AiProviderError["code"]): string {
  const messages: Record<AiProviderError["code"], string> = {
    AI_PROVIDER_AUTHENTICATION_FAILED: "The AI provider rejected the configured credentials.",
    AI_PROVIDER_MODEL_NOT_FOUND: "The configured AI model or deployment was not found.",
    AI_PROVIDER_QUOTA_EXCEEDED: "The AI provider quota has been exceeded.",
    AI_PROVIDER_UNAVAILABLE: "The AI provider is currently unavailable.",
    AI_PROVIDER_TEST_FAILED: "The AI provider request failed.",
    AI_PROVIDER_RESPONSE_INVALID: "The AI provider returned an invalid response."
  };
  return messages[code];
}
function paged<T>(items: T[], total: number, page: PageDto) {
  return {
    items,
    pagination: {
      page: page.page,
      pageSize: page.pageSize,
      total,
      pages: Math.ceil(total / page.pageSize)
    }
  };
}
