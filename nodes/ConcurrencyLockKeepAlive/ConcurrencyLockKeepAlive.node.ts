import type {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import Redis from 'ioredis';

// Returns 1 if renewed, 0 if expired (key gone), 2 if taken by another execution.
// When ignoreExpired (ARGV[3] == "1") and the key is gone, re-acquires the lock and returns 1.
// The entire script is atomic in Redis, so no race can occur between the GET and the SET.
const KEEP_ALIVE_SCRIPT = `
local current = redis.call("get", KEYS[1])
if current == ARGV[1] then
    redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2]))
    return 1
elseif current == false then
    if ARGV[3] == "1" then
        redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2]))
        return 1
    else
        return 0
    end
else
    return 2
end
`;

export class ConcurrencyLockKeepAlive implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Concurrency Lock Keep Alive [apm]',
        name: 'concurrencyLockKeepAlive',
        group: ['input'],
        version: 1,
        icon: {
            light: 'file:keep-alive.svg',
            dark: 'file:keep-alive-dark.svg',
        },
        subtitle: '',
        description: 'Keep workflow lock alive by refreshing TTL',
        defaults: {
            name: 'Keep Alive',
        },
        inputs: [NodeConnectionType.Main],
        outputs: [NodeConnectionType.Main, NodeConnectionType.Main, NodeConnectionType.Main],
        outputNames: ['Renewed', 'Expired', 'Taken'],
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
                displayName: 'Namespace',
                name: 'namespace',
                type: 'string',
                default: 'executions',
                required: true,
                description: 'Redis key prefix used to group locks. Must match the value used in the Check and Release nodes for the same workflow.',
            },
            {
                displayName: 'Redis Database',
                name: 'redisDb',
                type: 'number',
                default: 0,
                typeOptions: {
                    minValue: 0,
                },
                description: 'Logical database number (0-15 by default) where the lock keys live. Must match the value used in the Check and Release nodes of the same workflow. Defaults to 0 to preserve behavior of existing workflows.',
            },
            {
                displayName: 'Workflow ID',
                name: 'workflowId',
                type: 'string',
                default: '={{ $workflow.id }}',
                required: true,
                // eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
                description: 'Unique identifier for this lock. Must match the value used in the Check node.',
            },
            {
                displayName: 'TTL (Seconds)',
                name: 'ttl',
                type: 'number',
                default: 120,
                description: 'Seconds to reset the lock TTL to on each call. Should match the TTL configured in the Check node and be greater than the interval between Keep Alive calls.',
            },
            {
                displayName: 'Ignore Expired',
                name: 'ignoreExpired',
                type: 'boolean',
                default: true,
                noDataExpression: true,
                description: 'When enabled (default), if the lock TTL elapsed but no other execution holds it, the lock is silently re-acquired and the node exits via "Renewed". Disable this to detect expired locks explicitly via the "Expired" output.',
            },
        ],
    };

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const redisCredentials = await this.getCredentials('redis');
        if (!redisCredentials) {
            throw new NodeOperationError(this.getNode(), 'Redis credentials are missing');
        }

        const workflowId = this.getNodeParameter('workflowId', 0) as string;
        const namespace = this.getNodeParameter('namespace', 0) as string;
        const redisDb = this.getNodeParameter('redisDb', 0, 0) as number;
        const ttl = this.getNodeParameter('ttl', 0, 60) as number;
        const ignoreExpired = this.getNodeParameter('ignoreExpired', 0, true) as boolean;

        if (!workflowId || workflowId.trim() === '') {
            throw new NodeOperationError(this.getNode(), 'Workflow ID cannot be empty');
        }

        if (!namespace || namespace.trim() === '') {
            throw new NodeOperationError(this.getNode(), 'Namespace cannot be empty');
        }

        if (!Number.isInteger(redisDb) || redisDb < 0) {
            throw new NodeOperationError(this.getNode(), 'Redis Database must be a non-negative integer');
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
        const executionId = this.getExecutionId();

        try {
            await redis.connect();
            const result = await redis.eval(
                KEEP_ALIVE_SCRIPT,
                1,
                lockKey,
                executionId,
                ttl.toString(),
                ignoreExpired ? '1' : '0',
            );

            const json = { workflowId, executionId, lockKey };

            if (result === 1) {
                return [[{ json }], [], []];
            } else if (result === 0) {
                return [[], [{ json }], []];
            } else {
                return [[], [], [{ json }]];
            }
        } finally {
            await redis.quit();
        }
    }
}
