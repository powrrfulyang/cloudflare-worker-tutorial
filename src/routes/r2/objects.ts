import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { getAppInstance } from '@/core'
import { JsonResponse } from '@/zodSchemas/JsonResponse'

export const objectsRoute = getAppInstance()

// ─── Schemas ────────────────────────────────────────────────────────────────

const ObjectKeyParamSchema = z.object({
  key: z.string().min(1).openapi({ description: 'Object key (path) in the R2 bucket', example: 'images/photo.png' }),
})

const ListQuerySchema = z.object({
  prefix: z.string().optional().openapi({ description: 'Filter objects by key prefix', example: 'images/' }),
  cursor: z.string().optional().openapi({ description: 'Pagination cursor from a previous list response' }),
  limit: z.coerce.number().int().min(1).max(1000).optional().openapi({ description: 'Max number of objects to return (1-1000)', example: 20 }),
  delimiter: z.string().optional().openapi({ description: 'Delimiter for grouping keys into common prefixes', example: '/' }),
})

const R2ObjectSchema = z.object({
  key: z.string(),
  size: z.number(),
  etag: z.string(),
  httpEtag: z.string(),
  uploaded: z.string(),
  version: z.string(),
})

const ListResponseSchema = z.object({
  objects: z.array(R2ObjectSchema),
  truncated: z.boolean(),
  cursor: z.string().optional(),
  delimitedPrefixes: z.array(z.string()),
})

const HeadResponseSchema = R2ObjectSchema.extend({
  httpMetadata: z.record(z.string(), z.string()).optional(),
  customMetadata: z.record(z.string(), z.string()).optional(),
})

const DeleteResponseSchema = z.object({
  deleted: z.boolean(),
})

// ─── Middleware ─────────────────────────────────────────────────────────────

objectsRoute.use('*', async (ctx, next) => {
  const user = ctx.get('user')
  if (!user?.isAdmin) {
    throw new HTTPException(403, { message: 'Admin only' })
  }
  await next()
})

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /  —  List objects
 */
const listRoute = createRoute({
  path: '/',
  method: 'get',
  description: 'List objects in the R2 bucket with optional prefix filtering and pagination',
  request: {
    query: ListQuerySchema,
  },
  responses: JsonResponse(ListResponseSchema),
})

objectsRoute.openapi(listRoute, async (ctx) => {
  const { prefix, cursor, limit, delimiter } = ListQuerySchema.parse(ctx.req.query())

  const listed = await ctx.env.R2.list({
    prefix: prefix || undefined,
    cursor: cursor || undefined,
    limit: limit ?? 20,
    delimiter: delimiter || undefined,
  })

  return ctx.json({
    objects: listed.objects.map(serializeObject),
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : undefined,
    delimitedPrefixes: listed.delimitedPrefixes,
  })
})

/**
 * GET /:key  —  Download / get an object
 */
const getRoute = createRoute({
  path: '/{key}',
  method: 'get',
  description: 'Download an object from the R2 bucket by key',
  request: {
    params: ObjectKeyParamSchema,
  },
  responses: {
    200: {
      description: 'Object binary content',
    },
    404: {
      description: 'Object not found',
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
})

objectsRoute.openapi(getRoute, async (ctx) => {
  const { key } = ObjectKeyParamSchema.parse(ctx.req.param())
  const object = await ctx.env.R2.get(key)

  if (!object) {
    return ctx.json({ error: 'Object not found' }, 404)
  }

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', 'public, max-age=31536000, immutable')

  return new Response(object.body, { headers }) as any
})

/**
 * GET /meta/:key  —  Get object metadata
 */
const headRoute = createRoute({
  path: '/meta/{key}',
  method: 'get',
  operationId: 'headObject',
  description: 'Get metadata for an object without downloading its body',
  request: {
    params: ObjectKeyParamSchema,
  },
  responses: JsonResponse(HeadResponseSchema),
})

objectsRoute.openapi(headRoute, async (ctx) => {
  const { key } = ObjectKeyParamSchema.parse(ctx.req.param())
  const head = await ctx.env.R2.head(key)

  if (!head) {
    return ctx.json({ error: 'Object not found' }, 404) as any
  }

  const httpMetadata: Record<string, string> = {}
  if (head.httpMetadata) {
    for (const [k, v] of Object.entries(head.httpMetadata)) {
      if (typeof v === 'string') httpMetadata[k] = v
    }
  }

  return ctx.json({
    ...serializeObject(head),
    httpMetadata,
    customMetadata: head.customMetadata ?? {},
  })
})

/**
 * PUT /:key  —  Upload / overwrite an object
 */
const putRoute = createRoute({
  path: '/{key}',
  method: 'put',
  description: 'Upload or overwrite an object in the R2 bucket',
  request: {
    params: ObjectKeyParamSchema,
  },
  responses: JsonResponse(R2ObjectSchema),
})

objectsRoute.openapi(putRoute, async (ctx) => {
  const { key } = ObjectKeyParamSchema.parse(ctx.req.param())

  const contentType = ctx.req.header('content-type') || 'application/octet-stream'
  const body = await ctx.req.arrayBuffer()

  const object = await ctx.env.R2.put(key, body, {
    httpMetadata: { contentType },
  })

  return ctx.json(serializeObject(object))
})

/**
 * DELETE /:key  —  Delete an object
 */
const deleteRoute = createRoute({
  path: '/{key}',
  method: 'delete',
  description: 'Delete an object from the R2 bucket by key',
  request: {
    params: ObjectKeyParamSchema,
  },
  responses: JsonResponse(DeleteResponseSchema),
})

objectsRoute.openapi(deleteRoute, async (ctx) => {
  const { key } = ObjectKeyParamSchema.parse(ctx.req.param())
  await ctx.env.R2.delete(key)
  return ctx.json({ deleted: true })
})

// ─── Helpers ────────────────────────────────────────────────────────────────

function serializeObject(obj: R2Object) {
  return {
    key: obj.key,
    size: obj.size,
    etag: obj.etag,
    httpEtag: obj.httpEtag,
    uploaded: obj.uploaded.toISOString(),
    version: obj.version,
  }
}
