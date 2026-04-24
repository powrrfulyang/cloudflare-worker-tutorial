import { getAppInstance } from '@/core'
import { objectsRoute } from '@/routes/r2/objects'

export const r2App = getAppInstance()

r2App.route('/r2', objectsRoute)
