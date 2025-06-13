import type {
    IExecuteFunctions,
    INodeExecutionData,
    INodeType,
    INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import { DateTime } from 'luxon';
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
                    alwaysOpenEditWindow: true,  // Abre automáticamente el editor de expresiones
                    exposeResult: true,          // Hace que sea más fácil usar los resultados
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

        // Check if we're in test mode
        const isTestMode = this.getMode() === 'manual';

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

            const exists = await redis.exists(lockKey);

            // If we are in test mode and the ignoreInTestMode parameter is enabled,
            // ignore the lock and exit through "Idle" (even if the lock exists)
            if (isTestMode && ignoreInTestMode) {
                // Even if the lock exists, in test mode with ignoreInTestMode=true
                // we act as if it didn't exist, but WITHOUT DELETING the existing lock
                const currentDateTime = DateTime.now().toFormat('yyyy/MM/dd HH:mm');

                // We don't need to create a new key if it already exists
                if (!exists) {
                    await redis.set(lockKey, currentDateTime, 'EX', ttl);
                }

                return [[{
                    json: {
                        workflowId,
                        lastUpdate: currentDateTime,
                        testMode: true
                    }
                }], []];
            }

            // Normal behavior (outside test mode or with ignoreInTestMode=false)
            if (exists) {
                // The key ALREADY EXISTS → output 1 "Running" (second output)
                const lastUpdate = await redis.get(lockKey);
                return [[], [{
                    json: {
                        workflowId,
                        lastUpdate
                    }
                }]];
            } else {
                // The key DOES NOT EXIST → create and output 0 "Idle" (first output)
                const currentDateTime = DateTime.now().toFormat('yyyy/MM/dd HH:mm');
                await redis.set(lockKey, currentDateTime, 'EX', ttl);
                return [[{
                    json: {
                        workflowId,
                        lastUpdate: currentDateTime
                    }
                }], []];
            }
        } finally {
            await redis.quit();
        }

        return [[], []];
    }
}
