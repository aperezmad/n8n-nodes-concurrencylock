import type {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import Redis from 'ioredis';

// Returns 1 if released, 0 if expired (key gone), 2 if owned by another execution.
const RELEASE_SCRIPT = `
local current = redis.call("get", KEYS[1])
if current == ARGV[1] then
    redis.call("del", KEYS[1])
    return 1
elseif current == false then
    return 0
else
    return 2
end
`;

export class ConcurrencyLockRelease implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Concurrency Lock Release [apm]',
        name: 'concurrencyLockRelease',
        group: ['input'],
        version: 1,
        icon: {
            light: 'file:release.svg',
            dark: 'file:release-dark.svg',
        },
        subtitle: '',
        description: 'Release concurrency lock for a workflow',
        defaults: {
            name: 'Release Lock',
        },
        inputs: [NodeConnectionType.Main],
        outputs: [NodeConnectionType.Main, NodeConnectionType.Main, NodeConnectionType.Main],
        outputNames: ['Released', 'Expired', 'Not Owned'],
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
                description: 'Redis key prefix used to group locks. Must match the value used in the Check and Keep Alive nodes for the same workflow.',
            },
            {
                displayName: 'Redis Database',
                name: 'redisDb',
                type: 'number',
                default: 0,
                typeOptions: {
                    minValue: 0,
                },
                description: 'Logical database number (0-15 by default) where the lock keys live. Must match the value used in the Check and Keep Alive nodes of the same workflow. Defaults to 0 to preserve behavior of existing workflows.',
            },
            {
                displayName: 'Workflow ID',
                name: 'workflowId',
                type: 'string',
                default: '={{ $workflow.id }}',
                required: true,
                // eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
                description: 'Unique identifier for this lock. Must match the value used in the Check node. Only the execution that originally acquired the lock can release it.',
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
            const result = await redis.eval(RELEASE_SCRIPT, 1, lockKey, executionId);

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
