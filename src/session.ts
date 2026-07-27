// 实例发现、消歧与 client 签名身份加载——"建立会话"这一步的共用实现。
//
// 设计意图：status/doctor/setup 与全部邮件命令都需要"找到唯一目标实例"，
// 邮件命令还额外强制要求 client 签名身份（全部邮件 route 无条件要求签名，
// 未配对时扩展会 401 失败关闭，见 extension/src/protocol.ts 的
// validateMailRouteRequest）。把这两件事收进一个模块，cli.ts 的每条命令
// 只需调用，不需要各自重新实现发现/消歧/身份加载逻辑。
import { discoverInstances, DiscoveryError, type DiscoveredInstance } from "./discovery.js";
import { loadSigningIdentityFromKeychain, type SigningIdentity } from "./auth.js";
import { TransportError } from "./transport.js";
import type { GlobalOptions } from "./args.js";

export function selectInstance(instances: DiscoveredInstance[], options: Pick<GlobalOptions, "instance" | "profile">): DiscoveredInstance {
  const selected = instances.filter(({ descriptor }) =>
    options.instance ? descriptor.instanceId === options.instance : options.profile ? descriptor.profileId === options.profile : true,
  );
  if (selected.length === 0) throw new DiscoveryError("E_THUNDERBIRD_OFFLINE", "未发现可用的 Thunderbird 扩展实例");
  if (selected.length > 1) throw new DiscoveryError("E_AMBIGUOUS_INSTANCE", "发现多个 Thunderbird 实例，必须使用 --instance 或 --profile 消歧");
  return selected[0] as DiscoveredInstance;
}

/** 发现全部实例并消歧到唯一目标；descriptor 安全校验全部失败时给出比"未发现实例"更准确的诊断。 */
export async function discoverAndSelect(options: Pick<GlobalOptions, "instance" | "profile">): Promise<DiscoveredInstance> {
  const discovery = await discoverInstances();
  if (discovery.instances.length === 0 && discovery.rejected.length > 0) throw new DiscoveryError("E_VALIDATION", "所有 descriptor 均未通过安全校验");
  return selectInstance(discovery.instances, options);
}

/** 仅在提供了 --client 时才加载身份；用于 status 这类身份可选的探测命令。 */
export async function loadOptionalIdentity(options: Pick<GlobalOptions, "clientId">): Promise<SigningIdentity | undefined> {
  if (!options.clientId) return undefined;
  const identity = await loadSigningIdentityFromKeychain(options.clientId);
  if (!identity) throw new TransportError("E_AUTH", "未找到可用的本机 client 签名身份");
  return identity;
}

/**
 * 全部邮件命令的强制前置条件：必须提供 --client 且能从 Keychain 加载到对应
 * 签名身份。未提供 --client 视为"尚未配对/未选择身份"（E_NOT_PAIRED），
 * 提供了但加载不到视为本地认证失败（E_AUTH）——两者在 docs/03 的退出码
 * 表中分别映射到 3（未就绪）与 4（认证失败），语义不同，不能合并成一种错误。
 */
export async function requireMailIdentity(options: Pick<GlobalOptions, "clientId">): Promise<SigningIdentity> {
  // DiscoveryError 的 code 联合类型只覆盖发现阶段的三种错误，不包含
  // E_NOT_PAIRED；这里用 TransportError（code 是完整 ErrorCode 联合）表达
  // "本地尚未配对/未选择身份"，语义仍精确映射到退出码 3（未就绪）。
  if (!options.clientId) throw new TransportError("E_NOT_PAIRED", "邮件命令需要通过 --client 指定已配对的 clientId；请先运行 setup 完成配对", false);
  const identity = await loadSigningIdentityFromKeychain(options.clientId);
  if (!identity) throw new TransportError("E_AUTH", "未找到可用的本机 client 签名身份");
  return identity;
}
