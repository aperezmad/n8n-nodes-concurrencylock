import type {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import Redis from 'ioredis';

export class ConcurrencyLockCheck implements INodeType {
    description: INodeTypeDescription = {
        displayName: 'Concurrency Lock Check [apm]',
        name: 'concurrencyLockCheck',
        group: ['input'],
        version: 1,
        icon: {
            light: 'file:check.svg',
            dark: 'file:check-dark.svg',
        },
        subtitle: 'Check Running State',
        description: 'Check if a workflow is running and create lock if not',
        defaults: {
            name: 'Concurrency Lock Check',
        },
        inputs: [NodeConnectionType.Main],
        outputs: [NodeConnectionType.Main, NodeConnectionType.Main],
        outputNames: ['Idle', 'Running'],
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
                typeOptions: {
                    alwaysOpenEditWindow: true,
                    exposeResult: true,
                },
                description: 'The unique ID for the workflow',
            },
            {
                displayName: 'TTL (Seconds)',
                name: 'ttl',
                type: 'number',
                default: 120,
                description: 'Time-to-live for the lock in seconds',
            },
            {
                displayName: 'Ignore Lock in Test Mode',
                name: 'ignoreInTestMode',
                type: 'boolean',
                default: false,
                description: 'Whether to always allow execution when running in test mode',
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
        const ignoreInTestMode = this.getNodeParameter('ignoreInTestMode', 0) as boolean;

        const isTestMode = this.getMode() === 'manual';

        if (!workflowId || workflowId.trim() === '') {
            throw new NodeOperationError(this.getNode(), 'Workflow ID cannot be empty');
        }

        if (!namespace || namespace.trim() === '') {
            throw new NodeOperationError(this.getNode(), 'Namespace cannot be empty');
        }

        const lockKey = `${namespace}:${workflowId}`;
        const executionId = this.getExecutionId();

        try {
            await redis.connect();

            // SET NX EX is atomic: sets the key only if it does not exist.
            // The value is the execution ID, establishing ownership of the lock.
            const acquired = await redis.set(lockKey, executionId, 'EX', ttl, 'NX');

            if (isTestMode && ignoreInTestMode) {
                return [[{
                    json: { workflowId, executionId, lockKey, testMode: true }
                }], []];
            }

            if (acquired === 'OK') {
                return [[{
                    json: { workflowId, executionId, lockKey }
                }], []];
            } else {
                return [[], [{
                    json: { workflowId, executionId, lockKey }
                }]];
            }
        } finally {
            await redis.quit();
        }
    }
}
