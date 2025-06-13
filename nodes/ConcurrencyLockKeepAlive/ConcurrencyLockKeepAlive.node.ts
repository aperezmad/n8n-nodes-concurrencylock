import type {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import Redis from 'ioredis';

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
        subtitle: 'Keep Alive',
        description: 'Keep workflow lock alive by refreshing TTL',
        defaults: {
            name: 'Keep Alive',
        },
        inputs: [NodeConnectionType.Main],
        outputs: [NodeConnectionType.Main],
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
                description: 'Redis namespace to group keys, e.g., "executions" or "workflows:executions"',
            },
            {
                displayName: 'Workflow ID',
                name: 'workflowId',
                type: 'string',
                default: '={{ $workflow.id }}',
                required: true,
                // eslint-disable-next-line n8n-nodes-base/node-param-description-miscased-id
                description: 'The unique ID for the workflow usually ${workflow.id}',
            },
            {
                displayName: 'TTL (Seconds)',
                name: 'ttl',
                type: 'number',
                default: 120,
                description: 'Time-to-live for the lock in seconds',
            },
        ],
    };

    async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
        const redisCredentials = await this.getCredentials('redis');
        if (!redisCredentials) {
            throw new NodeOperationError(this.getNode(), 'Redis credentials are missing');
        }

        const redis = new Redis({
            host: redisCredentials.host as string,
            port: redisCredentials.port as number,
            password: redisCredentials.password as string,
            maxRetriesPerRequest: 3,
            lazyConnect: true,
            connectTimeout: 10000,
            commandTimeout: 5000,
        });

        const workflowId = this.getNodeParameter('workflowId', 0) as string;
        const namespace = this.getNodeParameter('namespace', 0) as string;
        const ttl = this.getNodeParameter('ttl', 0, 60) as number;

        // Validate workflowId
        if (!workflowId || workflowId.trim() === '') {
            throw new NodeOperationError(this.getNode(), 'Workflow ID cannot be empty');
        }

        // Validate namespace
        if (!namespace || namespace.trim() === '') {
            throw new NodeOperationError(this.getNode(), 'Namespace cannot be empty');
        }

        // Use configurable namespace
        const lockKey = `${namespace}:${workflowId}`;

        // Helper function to format the current date and time
        const getCurrentDateTime = (): string => {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            return `${year}/${month}/${day} ${hours}:${minutes}`;
        };

        try {
            await redis.connect();
            const currentDateTime = getCurrentDateTime();
            await redis.set(lockKey, currentDateTime, 'EX', ttl);
            return [[{
                json: {
                    workflowId,
                    lastUpdate: currentDateTime
                }
            }]];
        } finally {
            await redis.quit();
        }
    }
}
