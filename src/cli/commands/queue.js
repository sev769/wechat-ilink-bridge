import { parseCliArgs } from "../../config/load-config.js";
import { WxbError, cliSuccess } from "../../core/errors.js";
import { resolveFetchAccount } from "../../core/fetch-messages.js";
import {
  discardQueuedDelivery,
  listQueuedDeliveries,
  retryQueuedDeliveryById
} from "../../core/delivery-queue.js";
import { IlinkClient } from "../../core/ilink-client.js";
import { clearDeliveryQueue } from "../../state/delivery-queue-store.js";

function firstPositional(argv = []) {
  return argv.find((entry) => !entry.startsWith("--"));
}

export async function runQueueCommand(argv, context) {
  const [subcommand = "list", ...rest] = argv;
  const flags = parseCliArgs(rest);
  const account = await resolveFetchAccount(context.config.stateDir, flags.account === true ? undefined : flags.account);

  if (subcommand === "list") {
    const items = await listQueuedDeliveries(context.config.stateDir, account.accountId);
    return cliSuccess({
      accountId: account.accountId,
      items,
      count: items.length
    });
  }

  if (subcommand === "retry") {
    const queueId = firstPositional(rest);
    if (!queueId) {
      throw new WxbError("QUEUE_ITEM_REQUIRED", "Usage: wxb queue retry <queueId> [--force]", {
        retryable: false
      });
    }

    const client = context.client ?? new IlinkClient({
      baseUrl: account.baseUrl ?? context.config.baseUrl,
      channelVersion: context.config.channelVersion
    });
    const result = await retryQueuedDeliveryById({
      stateDir: context.config.stateDir,
      account,
      queueId,
      client,
      config: context.config,
      timeoutMs: context.config.fetchTimeoutMs,
      force: flags.force === true
    });

    return cliSuccess({
      accountId: account.accountId,
      ...result
    });
  }

  if (subcommand === "discard") {
    const queueId = firstPositional(rest);
    if (!queueId) {
      throw new WxbError("QUEUE_ITEM_REQUIRED", "Usage: wxb queue discard <queueId>", {
        retryable: false
      });
    }

    const discarded = await discardQueuedDelivery(context.config.stateDir, account.accountId, queueId);
    return cliSuccess({
      accountId: account.accountId,
      discarded
    });
  }

  if (subcommand === "clear") {
    const removed = await clearDeliveryQueue(context.config.stateDir, account.accountId, {
      userId: flags.user === true ? undefined : flags.user
    });
    return cliSuccess({
      accountId: account.accountId,
      removed
    });
  }

  throw new WxbError("QUEUE_COMMAND_UNKNOWN", `Unknown queue subcommand: ${subcommand}`, {
    retryable: false,
    details: { subcommand }
  });
}
