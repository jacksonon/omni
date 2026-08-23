# Omni 原生二进制 formula 模板。
# 发布流程：npm run compile 出 release/omni → 上传 GitHub Release →
#   shasum -a 256 release/omni 填入 sha256 → 提交本文件并 brew update。
class Omni < Formula
  desc "Omni — 终端 AI 编程助手（原生二进制，含全屏 TUI / headless exec / web 后端）"
  homepage "https://github.com/omni/omni"
  license "MIT"
  version "0.6.7"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/omni/omni/releases/download/v#{version}/omni-darwin-arm64"
      sha256 "REPLACE_WITH_SHA256_DARWIN_ARM64"
    else
      url "https://github.com/omni/omni/releases/download/v#{version}/omni-darwin-x64"
      sha256 "REPLACE_WITH_SHA256_DARWIN_X64"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/omni/omni/releases/download/v#{version}/omni-linux-arm64"
      sha256 "REPLACE_WITH_SHA256_LINUX_ARM64"
    else
      url "https://github.com/omni/omni/releases/download/v#{version}/omni-linux-x64"
      sha256 "REPLACE_WITH_SHA256_LINUX_X64"
    end
  end

  def install
    bin.install Dir["omni-*"].empty? ? "release/omni" : "omni-*" => "omni"
  end

  test do
    assert_match "omni", shell_output("#{bin}/omni --version")
  end
end
