import type {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import Redis from 'ioredis';

// Atomically renews TTL iff the key still belongs to the current execution.
// Returns 1 on success, 0 if ownership was lost or the key no longer exists.
const KEEP_ALIVE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("EXPIRE", KEYS[1], ARGV[2])
else
    return 0
end
`;

// Atomically deletes the key iff it still belongs to the current execution.
// Returns 1 on success, 0 if ownership was lost or the key no longer exists.
const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
`;

type LockOperation = 'check' | 'keepAlive' | 'release';

// Phase-3 dynamic outputs:
//   - check      -> 2 outputs: Idle (1st), Locked (2nd)
//   - keepAlive  -> 1 unnamed output
//   - release    -> 1 unnamed output
// Confirmed empirically in n8n-workflow@1.82.0 that returning an array of
// { type, displayName } objects produces both the correct pin count and the
// per-pin labels in the canvas, whereas a separate outputNames expression does
// not get evaluated. Omitting displayName on the keepAlive/release output
// leaves the pin without a label.
const OUTPUTS_DYNAMIC_EXPRESSION =
    '={{ ' +
    '$parameter["operation"] === "check"' +
    ' ? [' +
    '{ type: "main", displayName: "Idle" },' +
    '{ type: "main", displayName: "Locked" }' +
    ']' +
    ' : [' +
    '{ type: "main" }' +
    ']' +
    ' }}';

export class ConcurrencyLock implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Concurrency Lock [apm]',
        name: 'concurrencyLock',
        group: ['input'],
        version: 1,
        icon: {
            light: 'file:lock.svg',
            dark: 'file:lock-dark.svg',
        },
        subtitle: '={{ $parameter["operation"] }}',
        description: 'Manage concurrency locks in Redis (check, keep alive, release)',
        defaults: {
            name: 'Concurrency Lock',
        },
        inputs: [NodeConnectionType.Main],
        // outputs are resolved dynamically via expression against $parameter["operation"].
        outputs: OUTPUTS_DYNAMIC_EXPRESSION as unknown as NodeConnectionType[],
        credentials: [
            {
                // eslint-disable-next-line n8n-nodes-base/node-class-description-credentials-name-unsuffixed
                name: 'redis',
                required: true,
            },
        ],
        codex: {
            categories: ['Development'],
            subcategories: {
                Development: ['Helpers'],
            },
        },
        properties: [
            {
                displayName: 'Action',
                name: 'operation',
                type: 'options',
                noDataExpression: true,
                options: [
                    {
                        name: 'Check',
                        value: 'check',
                        description: 'Atomically check whether the workflow is already running and create the lock if not',
                        action: 'Check if the workflow is running and create a lock',
                    },
                    {
                        name: 'Keep Alive',
                        value: 'keepAlive',
                        description: 'Refresh the TTL of an existing lock. Use Use Ownership to verify the lock belongs to this execution before renewing.',
                        action: 'Refresh the TTL of the lock',
                    },
                    {
                        name: 'Release',
                        value: 'release',
                        description: 'Release the lock. Use Use Ownership to verify the lock belongs to this execution before deleting.',
                        action: 'Release the lock',
                    },
                ],
                default: 'check',
            },
            {
                displayName: 'Namespace',
                name: 'namespace',
                type: 'string',
                default: 'executions',
                required: true,
                description: 'Redis key prefix used to group locks. Must match across all Concurrency Lock nodes of the same workflow. Example: "executions" produces the key "executions:&lt;workflowId&gt;".',
            },
            {
                displayName: 'Redis Database',
                name: 'redisDb',
                type: 'number',
                default: 0,
                typeOptions: {
                    minValue: 0,
                },
                description: 'Logical database number (0-15 by default) where the lock keys live. Must match across all Concurrency Lock nodes of the same workflow. Defaults to 0 to preserve behavior of existing workflows.',
            },
            {
                displayName: 'Workflow ID',
                name: 'workflowId',
                type: 'string',
                default: '={{ $workflow.id }}',
                required: true,
                typeOptions: {
                    alwaysOpenEditWindow: true,
                    exposeResult: true,
                },
                description: 'Unique identifier for this lock. Defaults to the current workflow ID. Change it only if you need multiple independent locks within the same workflow. All Concurrency Lock nodes of the same workflow must use the same value.',
            },
            {
                displayName: 'TTL (Seconds)',
                name: 'ttl',
                type: 'number',
                default: 120,
                description: 'Seconds before the lock auto-expires if not renewed. In Check, sets the initial TTL when the lock is created; in Keep Alive, resets the TTL on each call. Set this higher than the interval between Keep Alive calls to avoid unintended expiration.',
            },
            {
                displayName: 'Use Ownership',
                name: 'useOwnership',
                type: 'boolean',
                default: false,
                noDataExpression: true,
                displayOptions: {
                    show: {
                        operation: ['check', 'keepAlive', 'release'],
                    },
                },
                description: 'Whether the lock value is the execution ID of the n8n execution that acquired it. When enabled, Keep Alive and Release verify ownership atomically before acting and throw an error if ownership is lost. When disabled, the lock is just a presence flag with no owner verification.',
            },
        ],
    };

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const redisCredentials = await this.getCredentials('redis');
        if (!redisCredentials) {
            throw new NodeOperationError(this.getNode(), 'Redis credentials are missing');
        }

        const items = this.getInputData();
        const operation = this.getNodeParameter('operation', 0) as LockOperation;
        const numOutputs = operation === 'check' ? 2 : 1;
        const returnData: INodeExecutionData[][] = Array.from(
            { length: numOutputs },
            () => [],
        );
        const executionId = this.getExecutionId();

        for (let i = 0; i < items.length; i++) {
            try {
                const namespace = this.getNodeParameter('namespace', i) as string;
                const workflowId = this.getNodeParameter('workflowId', i) as string;
                const redisDb = this.getNodeParameter('redisDb', i, 0) as number;
                const ttl = this.getNodeParameter('ttl', i, 60) as number;
                const useOwnership = this.getNodeParameter('useOwnership', i, false) as boolean;

                if (!workflowId || workflowId.trim() === '') {
                    throw new NodeOperationError(this.getNode(), 'Workflow ID cannot be empty', { itemIndex: i });
                }
                if (!namespace || namespace.trim() === '') {
                    throw new NodeOperationError(this.getNode(), 'Namespace cannot be empty', { itemIndex: i });
                }
                if (!Number.isInteger(redisDb) || redisDb < 0) {
                    throw new NodeOperationError(this.getNode(), 'Redis Database must be a non-negative integer', { itemIndex: i });
                }

                const redis = new Redis({
                    host: redisCredentials.host as string,
                    port: redisCredentials.port as number,
                    password: redisCredentials.password as string,
                    db: redisDb,
                    maxRetriesPerRequest: 3,
                    lazyConnect: true,
                    connectTimeout: 10000,
                    commandTimeout: 5000,
                });

                const lockKey = `${namespace}:${workflowId}`;

                try {
                    await redis.connect();

                    if (operation === 'check') {
                        const value = useOwnership ? executionId : '1';
                        // SET key value EX ttl NX is atomic: only sets the key if it does not exist.
                        const acquired = await redis.set(lockKey, value, 'EX', ttl, 'NX');
                        // Pin 0 = Idle (lock acquired), Pin 1 = Locked (lock already held).
                        const json = {
                            operation: 'check',
                            lockKey,
                            workflowId,
                            executionId,
                            acquired: acquired === 'OK',
                            ownership: useOwnership,
                            namespace,
                            redisDb,
                            ttl,
                        };
                        if (acquired === 'OK') {
                            returnData[0].push({ json, pairedItem: { item: i } });
                        } else {
                            returnData[1].push({ json, pairedItem: { item: i } });
                        }
                        continue;
                    }

                    if (operation === 'keepAlive') {
                        if (useOwnership) {
                            const ok = (await redis.eval(
                                KEEP_ALIVE_IF_OWNER_SCRIPT,
                                1,
                                lockKey,
                                executionId,
                                ttl.toString(),
                            )) as number;
                            if (ok !== 1) {
                                throw new NodeOperationError(
                                    this.getNode(),
                                    `The lock "${lockKey}" no longer belongs to this execution (TTL may have expired or another execution took ownership).`,
                                    { itemIndex: i },
                                );
                            }
                        } else {
                            const renewed = (await redis.expire(lockKey, ttl)) as number;
                            if (renewed !== 1) {
                                throw new NodeOperationError(
                                    this.getNode(),
                                    `Cannot refresh TTL: lock "${lockKey}" does not exist.`,
                                    { itemIndex: i },
                                );
                            }
                        }
                        returnData[0].push({
                            json: {
                                operation: 'keepAlive',
                                lockKey,
                                workflowId,
                                executionId,
                                ownership: useOwnership,
                                namespace,
                                redisDb,
                                ttl,
                            },
                            pairedItem: { item: i },
                        });
                        continue;
                    }

                    // Release
                    if (useOwnership) {
                        const ok = (await redis.eval(
                            RELEASE_IF_OWNER_SCRIPT,
                            1,
                            lockKey,
                            executionId,
                        )) as number;
                        if (ok !== 1) {
                            throw new NodeOperationError(
                                this.getNode(),
                                `Cannot release lock "${lockKey}": it does not belong to this execution or no longer exists.`,
                                { itemIndex: i },
                            );
                        }
                    } else {
                        const released = (await redis.del(lockKey)) as number;
                        if (released !== 1) {
                            throw new NodeOperationError(
                                this.getNode(),
                                `Cannot release lock "${lockKey}": it does not exist.`,
                                { itemIndex: i },
                            );
                        }
                    }
                    returnData[0].push({
                        json: {
                            operation: 'release',
                            lockKey,
                            workflowId,
                            executionId,
                            ownership: useOwnership,
                            namespace,
                            redisDb,
                        },
                        pairedItem: { item: i },
                    });
                } finally {
                    await redis.quit();
                }
            } catch (error) {
                if (this.continueOnFail()) {
                    returnData[0].push({
                        json: { error: (error as Error).message },
                        pairedItem: { item: i },
                    });
                    continue;
                }
                throw error;
            }
        }

        return returnData;
    }
}
