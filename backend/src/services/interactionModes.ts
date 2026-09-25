/**
 * Interaction Modes Service - Supports different interaction styles
 */

import { aiProviderService, AIProvider } from './aiProviders'

export type InteractionMode = 'ask' | 'plan' | 'agentic' | 'automation'

export interface TaskStep {
  step: number
  action: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  result?: string
  error?: string
}

export interface Plan {
  goal: string
  steps: TaskStep[]
  estimatedTime?: string
  resources?: string[]
}

export interface AgenticTask {
  id: string
  goal: string
  status: 'planning' | 'executing' | 'completed' | 'failed'
  plan?: Plan
  currentStep?: number
  results?: any[]
  error?: string
}

export class InteractionModesService {
  /**
   * Ask Mode - Simple Q&A
   */
  async askMode(
    messages: Array<{ role: string; content: string }>,
    provider: AIProvider,
    model: string,
    apiKey?: string
  ): Promise<string> {
    // Simple direct response
    return aiProviderService.getChatCompletion(provider, messages, model, apiKey)
  }

  /**
   * Plan Mode - Create a plan before execution
   */
  async planMode(
    userQuery: string,
    messages: Array<{ role: string; content: string }>,
    provider: AIProvider,
    model: string,
    apiKey?: string
  ): Promise<{ response: string; plan: Plan }> {
    // Ask the AI to create a plan
    const planningPrompt = `The user wants to: ${userQuery}

Please create a detailed step-by-step plan to accomplish this goal. Format your response as follows:

PLAN:
1. [First step description]
2. [Second step description]
3. [Continue with more steps...]

RESPONSE:
[Your initial response or thoughts about the plan]`

    const planningMessages = [
      ...messages.slice(0, -1), // Previous messages
      {
        role: 'user' as const,
        content: planningPrompt,
      },
    ]

    const planResponse = await aiProviderService.getChatCompletion(
      provider,
      planningMessages,
      model,
      apiKey
    )

    // Parse the plan from response
    const plan = this.parsePlan(planResponse, userQuery)

    return {
      response: planResponse,
      plan,
    }
  }

  /**
   * Agentic Mode - Autonomous agent that plans and executes
   */
  async agenticMode(
    userQuery: string,
    messages: Array<{ role: string; content: string }>,
    provider: AIProvider,
    model: string,
    apiKey?: string
  ): Promise<{ response: string; plan?: Plan; execution?: any }> {
    // Step 1: Create a plan
    const planResult = await this.planMode(userQuery, messages, provider, model, apiKey)

    // Step 2: Execute the plan (simulated execution for now)
    const executionPrompt = `Based on this plan:
${planResult.plan.steps.map(s => `${s.step}. ${s.action}: ${s.description}`).join('\n')}

Execute each step and provide results. For each step, indicate:
- Status (completed/failed)
- Result or error message

Format:
EXECUTION:
Step 1: [status] - [result/error]
Step 2: [status] - [result/error]
...

SUMMARY:
[Final summary of execution]`

    const executionMessages = [
      ...messages,
      {
        role: 'assistant' as const,
        content: planResult.response,
      },
      {
        role: 'user' as const,
        content: executionPrompt,
      },
    ]

    const executionResponse = await aiProviderService.getChatCompletion(
      provider,
      executionMessages,
      model,
      apiKey
    )

    // Update plan with execution results
    const executedPlan = this.updatePlanWithExecution(planResult.plan, executionResponse)

    return {
      response: executionResponse,
      plan: executedPlan,
      execution: {
        completed: executedPlan.steps.filter(s => s.status === 'completed').length,
        total: executedPlan.steps.length,
        results: executedPlan.steps.map(s => ({
          step: s.step,
          action: s.action,
          status: s.status,
          result: s.result,
          error: s.error,
        })),
      },
    }
  }

  /**
   * Automation Mode - Scheduled/triggered automated tasks
   */
  async automationMode(
    userQuery: string,
    messages: Array<{ role: string; content: string }>,
    provider: AIProvider,
    model: string,
    apiKey?: string,
    schedule?: { frequency?: string; trigger?: string }
  ): Promise<{ response: string; automation: any }> {
    // Create an automation plan
    const automationPrompt = `The user wants to automate: ${userQuery}

Create an automation script/plan that can be executed automatically. Consider:
- What needs to be automated
- When it should run (schedule/triggers)
- What actions to take
- Error handling
- Success criteria

Format:
AUTOMATION:
[Description of automation]

SCHEDULE:
[When/how often to run]

STEPS:
1. [Automated action]
2. [Next action]
...

MONITORING:
[What to monitor and alert on]`

    const automationMessages = [
      ...messages,
      {
        role: 'user' as const,
        content: automationPrompt,
      },
    ]

    const automationResponse = await aiProviderService.getChatCompletion(
      provider,
      automationMessages,
      model,
      apiKey
    )

    const automation = this.parseAutomation(automationResponse, schedule)

    return {
      response: automationResponse,
      automation,
    }
  }

  /**
   * Parse plan from AI response
   */
  private parsePlan(response: string, goal: string): Plan {
    const lines = response.split('\n')
    const steps: TaskStep[] = []
    let inPlanSection = false
    let stepNumber = 1

    for (const line of lines) {
      const trimmed = line.trim()

      if (trimmed.toLowerCase().includes('plan:')) {
        inPlanSection = true
        continue
      }

      if (inPlanSection && /^\d+[.)]\s/.test(trimmed)) {
        const stepText = trimmed.replace(/^\d+[.)]\s*/, '')
        steps.push({
          step: stepNumber++,
          action: stepText.split(':')[0] || stepText,
          description: stepText.split(':').slice(1).join(':').trim() || stepText,
          status: 'pending',
        })
      }

      if (trimmed.toLowerCase().includes('response:') || trimmed.toLowerCase().includes('execution:')) {
        break
      }
    }

    // If no structured plan found, create one from the response
    if (steps.length === 0) {
      steps.push({
        step: 1,
        action: 'Analyze and understand the goal',
        description: goal,
        status: 'pending',
      })
    }

    return {
      goal,
      steps,
    }
  }

  /**
   * Update plan with execution results
   */
  private updatePlanWithExecution(plan: Plan, executionResponse: string): Plan {
    const updatedSteps = [...plan.steps]
    const lines = executionResponse.split('\n')
    let inExecutionSection = false

    for (const line of lines) {
      const trimmed = line.trim()

      if (trimmed.toLowerCase().includes('execution:')) {
        inExecutionSection = true
        continue
      }

      if (inExecutionSection && /^step\s+\d+:/i.test(trimmed)) {
        const match = trimmed.match(/^step\s+(\d+):\s*(\w+)\s*-\s*(.+)/i)
        if (match) {
          const stepNum = parseInt(match[1])
          const status = match[2].toLowerCase()
          const result = match[3]

          const stepIndex = updatedSteps.findIndex(s => s.step === stepNum)
          if (stepIndex >= 0) {
            updatedSteps[stepIndex] = {
              ...updatedSteps[stepIndex],
              status: this.parseStatus(status),
              result: result,
              error: status.includes('fail') ? result : undefined,
            }
          }
        }
      }
    }

    return {
      ...plan,
      steps: updatedSteps,
    }
  }

  /**
   * Parse automation from response
   */
  private parseAutomation(response: string, schedule?: { frequency?: string; trigger?: string }): any {
    const sections: any = {}
    let currentSection = ''
    const lines = response.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      const sectionMatch = trimmed.match(/^(\w+):\s*$/i)

      if (sectionMatch) {
        currentSection = sectionMatch[1].toLowerCase()
        sections[currentSection] = ''
      } else if (currentSection && trimmed) {
        sections[currentSection] = (sections[currentSection] || '') + '\n' + trimmed
      }
    }

    return {
      description: sections.automation || sections.description || response,
      schedule: schedule || {
        frequency: sections.schedule || 'on-demand',
        trigger: sections.trigger || 'manual',
      },
      steps: sections.steps ? sections.steps.split(/\d+[.)]\s*/).filter((s: string) => s.trim()).map((s: string, i: number) => ({
        step: i + 1,
        action: s.trim(),
        status: 'pending' as const,
      })) : [],
      monitoring: sections.monitoring || 'Monitor execution status and errors',
    }
  }

  /**
   * Parse status string to TaskStep status
   */
  private parseStatus(status: string): TaskStep['status'] {
    const lower = status.toLowerCase()
    if (lower.includes('complete') || lower.includes('success')) return 'completed'
    if (lower.includes('fail') || lower.includes('error')) return 'failed'
    if (lower.includes('progress') || lower.includes('executing')) return 'in_progress'
    return 'pending'
  }
}

export const interactionModesService = new InteractionModesService()

