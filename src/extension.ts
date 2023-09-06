import { Prisma } from '@prisma/client/extension.js'

import { ConfigureReplicaCallback, ReplicaManager } from './ReplicaManager'

export type ReplicasOptions = {
  url: string | string[]
}

const readOperations = [
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'groupBy',
  'aggregate',
  'count',
  'queryRaw',
  'queryRawUnsafe',
  'findRaw',
  'aggregateRaw',
]

export const readReplicas = (options: ReplicasOptions, configureReplicaClient?: ConfigureReplicaCallback) =>
  Prisma.defineExtension((client) => {
    const PrismaClient = Object.getPrototypeOf(client).constructor
    const datasourceName = Object.keys(options).find((key) => !key.startsWith('$'))
    if (!datasourceName) {
      throw new Error(`Read replicas options must specify a datasource`)
    }
    let replicaUrls = options.url
    if (typeof replicaUrls === 'string') {
      replicaUrls = [replicaUrls]
    } else if (!Array.isArray(replicaUrls)) {
      throw new Error(`Replica URLs must be a string or list of strings`)
    }

    const replicaManager = new ReplicaManager({
      replicaUrls,
      clientConstructor: PrismaClient,
      configureCallback: configureReplicaClient,
    })

    return client.$extends({
      client: {
        $primary<T>(this: T): Omit<T, '$primary'> {
          return client as unknown as Omit<T, '$primary'>
        },

        async $connect() {
          await Promise.all([(client as any).$connect(), replicaManager.connectAll()])
        },

        async $disconnect() {
          await Promise.all([(client as any).$disconnect(), replicaManager.disconnectAll()])
        },
      },

      query: {
        $allOperations({
          args,
          model,
          operation,
          query,
          // @ts-expect-error
          __internalParams: { transaction },
        }) {
          if (transaction) {
            return query(args)
          }
          if (readOperations.includes(operation)) {
            const replica = replicaManager.pickReplica()
            if (model) {
              return replica[model][operation](args)
            }
            return replica[operation](args)
          }

          return query(args)
        },
      },
    })
  })
