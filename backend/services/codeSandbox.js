// 强沙箱：基于 Docker 的隔离执行环境，用于第三方任意代码试跑
//
// 隔离策略（尽力覆盖 OWASP 建议的容器加固）：
//   - NetworkMode: none          —— 完全断网，杜绝数据外传/下载
//   - Memory / NanoCpus / PidsLimit —— 资源上限
//   - CapDrop: ALL + no-new-privileges —— 丢弃全部 capability、禁止提权
//   - ReadonlyRootfs + tmpfs(/tmp, noexec,nosuid) —— 只读根文件系统
//   - 超时强杀 + 容器强制删除 —— 防资源驻留
//
// 部署要求：后端容器需挂载 /var/run/docker.sock，且服务器有 Docker。
// 注意：docker.sock 挂载赋予后端宿主机级权限，属常规"sidecar 沙箱"取舍；
// 如要完全隔离宿主，建议独立沙箱服务 + 无 socket 的 worker 模型。
import Docker from 'dockerode';

const docker = new Docker(); // 默认 unix:///var/run/docker.sock

const IMAGES = {
  node: 'node:20-alpine',
  python: 'python:3.11-alpine',
  shell: 'alpine:3',
};

const RUNNERS = { node: 'node', python: 'python', shell: 'sh' };
const EXT = { node: 'js', python: 'py', shell: 'sh' };
const PULL_TIMEOUT_MS = 120_000;

export async function isDockerAvailable() {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

async function ensureImage(image) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch { /* 未拉取，继续 */ }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`拉取镜像超时: ${image}`)), PULL_TIMEOUT_MS);
    docker.pull(image, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      docker.modem.followProgress(stream, (pullErr) => {
        clearTimeout(timer);
        pullErr ? reject(pullErr) : resolve();
      }, () => {});
    });
  });
}

/**
 * 在强沙箱内运行任意代码
 * @param {{language: 'node'|'python'|'shell', code: string, timeoutMs?: number, memoryMb?: number, cpuCpus?: number}} opts
 * @returns {Promise<{ok: boolean, exit?: number, stdout?: string, stderr?: string, durationMs?: number, error?: string}>}
 */
export async function runInStrongSandbox({
  language = 'shell',
  code = '',
  timeoutMs = 5000,
  memoryMb = 128,
  cpuCpus = 0.5,
} = {}) {
  const image = IMAGES[language];
  const runner = RUNNERS[language];
  if (!image || !runner) {
    return { ok: false, error: `不支持的语言类型: ${language}` };
  }
  try {
    await ensureImage(image);
  } catch (e) {
    return { ok: false, error: `沙箱镜像准备失败: ${e.message}` };
  }

  const name = `xclaw-sbx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const ext = EXT[language];
  let container;
  try {
    container = await docker.createContainer({
      Image: image,
      name,
      Cmd: ['sh', '-c', `cat > /tmp/code.${ext} && ${runner} /tmp/code.${ext}`],
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        NetworkMode: 'none',
        Memory: Math.max(8, memoryMb) * 1024 * 1024,
        NanoCpus: Math.max(1, Math.round(cpuCpus * 1e9)),
        PidsLimit: 128,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'size=64m,noexec,nosuid' },
      },
    });
  } catch (e) {
    return { ok: false, error: `创建沙箱容器失败: ${e.message}` };
  }

  const startedAt = Date.now();
  const outChunks = [];
  const errChunks = [];
  try {
    const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true });
    docker.modem.demuxStream(
      stream,
      { write: (c) => outChunks.push(c) },
      { write: (c) => errChunks.push(c) }
    );
    const waitExit = new Promise((resolve) => container.wait(resolve));
    const killTimer = setTimeout(() => {
      container.kill({ signal: 'SIGKILL' }).catch(() => {});
    }, timeoutMs);
    await container.start();
    stream.end(code);
    const [status] = await waitExit;
    clearTimeout(killTimer);
    const exit = status?.StatusCode ?? (status?.Error ? 1 : 0);
    const stdout = Buffer.concat(outChunks).toString('utf8').slice(0, 2000);
    const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 2000);
    return { ok: true, exit, stdout, stderr, durationMs: Date.now() - startedAt };
  } catch (e) {
    return { ok: false, error: `沙箱执行异常: ${e.message}` };
  } finally {
    if (container) {
      container.remove({ force: true }).catch(() => {});
    }
  }
}
