import { type NextRequest, NextResponse } from "next/server"
import { ZodTypeAny, z } from "zod"
import { openai } from "@/lib/openai"
import { EXAMPLE_ANSWER, EXAMPLE_PROMPT } from "./example"

function determineSchemaType(schema: any) {
  if (!schema.hasOwnProperty("type")) {
    if (Array.isArray(schema)) {
      return "array"
    } else {
      return typeof schema
    }
  }

  return schema.type
}

function jsonSchemaToZod(schema: any): ZodTypeAny {
  const type = determineSchemaType(schema)

  switch (type) {
    case "string":
      return z.string().nullable()
    case "number":
      return z.number().nullable()
    case "boolean":
      return z.boolean().nullable()
    case "array":
      return z.array(jsonSchemaToZod(schema.items)).nullable()
    case "object":
      const shape: Record<string, ZodTypeAny> = {}

      for (const key in schema) {
        if (key !== "type") {
          shape[key] = jsonSchemaToZod(schema[key])
        }
      }

      return z.object(shape)
    default:
      throw new Error(`Unsupported data type: ${type}`)
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json()

  // Validate incoming request
  const genericSchema = z.object({
    data: z.string(),
    format: z.object({}).passthrough(),
  })

  const { data, format } = genericSchema.parse(body)

  // Create dymanic schema from user input
  const dynamicSchema = jsonSchemaToZod(format)

  // Retry mechanism

  type PromiseExecutor<T> = (
    resolve: (value: T) => void,
    reject: (reason?: any) => void
  ) => void

  class RetryablePromise<T> extends Promise<T> {
    static async retry<T>(
      retries: number,
      executor: PromiseExecutor<T>
    ): Promise<T> {
      return new RetryablePromise(executor).catch((error) => {
        console.error(`Retrying due to error: ${error}`)

        return retries > 0
          ? RetryablePromise.retry(retries - 1, executor)
          : RetryablePromise.reject()
      })
    }
  }

  const validationResult = await RetryablePromise.retry<object>(
    3,
    async (resolve, reject) => {
      try {
        // AI response
        const content = `DATA: \n"${data}"\n\n-----------\nExpected JSON format: 
${JSON.stringify(format, null, 2)}
\n\n-----------\nValid JSON output in expected format:`

        const res = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            {
              role: "assistant",
              content:
                "You are an AI that converts data into the attached JSON format. You respond with nothing but valid JSON based on the input data. Your output should DIRECTLY be valid JSON, nothing added before or after. You will begin with the opening curly brace and end with the closing curly brace. Only if you absolutely cannot determine a field, use the value null.",
            },
            {
              role: "user",
              content: EXAMPLE_PROMPT,
            },
            {
              role: "user",
              content: EXAMPLE_ANSWER,
            },
            {
              role: "user",
              content,
            },
          ],
        })

        const text = res.choices[0].message.content

        // Validate json
        const validationResult = dynamicSchema.parse(JSON.parse(text || ""))

        return resolve(validationResult)
      } catch (err) {
        reject(err)
      }
    }
  )

  return NextResponse.json(validationResult, { status: 200 })
}
