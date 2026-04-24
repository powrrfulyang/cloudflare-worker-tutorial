declare global {
  interface Bindings {
    DB: D1Database
    KV: KVNamespace
    R2: R2Bucket
    ENVIRONMENT: 'local' | 'production'
    JWT_SECRET: string
  }
}

export {}
