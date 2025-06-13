import type {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import Redis from 'ioredis';

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
        subtitle: 'Release Lock',
        description: 'Release concurrency lock for a workflow',
        defaults: {
            name: 'Release Lock',
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

        try {
            await redis.connect();
            await redis.del(lockKey);
            return [[{
                json: {
                    workflowId,
                    lastUpdate: null
                }
            }]];
        } finally {
            await redis.quit();
        }
    }
}
