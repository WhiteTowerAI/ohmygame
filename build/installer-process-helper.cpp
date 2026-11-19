#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <restartmanager.h>

#include <cstdio>
#include <cwchar>
#include <clocale>
#include <string>
#include <vector>

namespace {
constexpr int failed = 2;
constexpr int mainRunning = 10;
constexpr int runtimeRunning = 11;
constexpr const wchar_t* bundledExecutables[] = {
  L"resources\\runtime\\node\\node.exe",
  L"resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe",
  L"resources\\app.asar.unpacked\\node_modules\\@esbuild\\win32-x64\\esbuild.exe",
  L"resources\\app.asar.unpacked\\node_modules\\recheck-windows-x64\\recheck.exe",
};
std::wstring diagnosticLog;

struct Handle {
  HANDLE value;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

void report(const wchar_t* stage, DWORD pid, DWORD error = 0, const wchar_t* path = L"") {
  std::wprintf(L"%ls pid=%lu win32-error=%lu %ls\n", stage, pid, error, path);
  if (diagnosticLog.empty()) return;
  Handle log(CreateFileW(diagnosticLog.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (log.value == INVALID_HANDLE_VALUE) return;
  const auto message = std::wstring(stage) + L" pid=" + std::to_wstring(pid) +
    L" win32-error=" + std::to_wstring(error) + L" " + path + L"\r\n";
  DWORD written = 0;
  WriteFile(log.value, message.data(), static_cast<DWORD>(message.size() * sizeof(wchar_t)),
    &written, nullptr);
}

std::wstring imagePath(HANDLE process) {
  std::wstring path(32768, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process, 0, path.data(), &size)) return {};
  path.resize(size);
  return path;
}

std::wstring canonicalPath(const std::wstring& path) {
  Handle file(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return {};
  std::wstring result(32768, L'\0');
  const auto length = GetFinalPathNameByHandleW(file.value, result.data(),
    static_cast<DWORD>(result.size()), FILE_NAME_NORMALIZED);
  if (length == 0 || length >= result.size()) return {};
  result.resize(length);
  return result;
}

const wchar_t* fileName(const std::wstring& path) {
  const auto separator = path.find_last_of(L'\\');
  return path.c_str() + (separator == std::wstring::npos ? 0 : separator + 1);
}

bool samePath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}

bool creationTime(HANDLE process, FILETIME& creation) {
  FILETIME exit, kernel, user;
  return GetProcessTimes(process, &creation, &exit, &kernel, &user);
}

BOOL CALLBACK closeWindow(HWND window, LPARAM process) {
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == static_cast<DWORD>(process) && GetWindow(window, GW_OWNER) == nullptr &&
      IsWindowVisible(window)) {
    PostMessageW(window, WM_CLOSE, 0, 0);
  }
  return TRUE;
}

enum class Action { probe, close, clean, force };

struct Executable {
  std::wstring name;
  std::wstring path;
  bool main;
};

bool addExecutable(std::vector<Executable>& executables, const std::wstring& root,
                   const std::wstring& relative, bool main) {
  const auto expected = root + L"\\" + relative;
  const auto attrs = GetFileAttributesW(expected.c_str());
  if (attrs == INVALID_FILE_ATTRIBUTES) {
    const auto error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return true;
    report(L"executable-attributes-failed", 0, error, expected.c_str());
    return false;
  }
  if (attrs & FILE_ATTRIBUTE_DIRECTORY) return true;
  const auto path = canonicalPath(expected);
  if (path.empty()) {
    report(L"executable-path-failed", 0, GetLastError(), expected.c_str());
    return false;
  }
  // Reject junctions and symlinks that redirect any part of an executable path.
  if (samePath(path, expected)) {
    executables.push_back({fileName(relative), path, main});
  } else {
    report(L"redirected-executable-skipped", 0, 0, expected.c_str());
  }
  return true;
}

bool exited(HANDLE process) {
  return WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
}

bool queryExited(HANDLE process) {
  DWORD code = STILL_ACTIVE;
  return GetExitCodeProcess(process, &code) && code != STILL_ACTIVE;
}

int scan(const std::vector<Executable>& executables, Action action) {
  if (executables.empty()) return 0;
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE) {
    report(L"snapshot-failed", 0, GetLastError());
    return failed;
  }
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) {
    report(L"enumerate-failed", 0, GetLastError());
    return failed;
  }

  int result = 0;
  const auto deadline = GetTickCount64() + 8000;
  do {
    for (const auto& executable : executables) {
      if (!samePath(entry.szExeFile, executable.name)) continue;
      const auto pid = entry.th32ProcessID;
      Handle query(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
      if (!query.value) {
        const auto error = GetLastError();
        if (error == ERROR_INVALID_PARAMETER) continue; // The process already exited.
        report(L"query-open-failed", pid, error, entry.szExeFile);
        result = failed;
        continue;
      }
      if (queryExited(query.value)) continue;
      const auto path = imagePath(query.value);
      if (path.empty()) {
        const auto error = GetLastError();
        if (queryExited(query.value)) continue;
        report(L"query-image-failed", pid, error, entry.szExeFile);
        result = failed;
        continue;
      }
      if (!samePath(canonicalPath(path), executable.path)) continue;
      report(L"matched", pid, 0, path.c_str());

      if (action == Action::probe || (action == Action::clean && executable.main)) {
        if (result != failed && (executable.main || result == 0)) {
          result = executable.main ? mainRunning : runtimeRunning;
        }
        continue;
      }
      if (action == Action::close) {
        if (executable.main) EnumWindows(closeWindow, static_cast<LPARAM>(pid));
        continue;
      }

      if (GetTickCount64() >= deadline) {
        report(L"cleanup-deadline", pid, WAIT_TIMEOUT, path.c_str());
        return failed;
      }
      Handle target(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE |
        SYNCHRONIZE, FALSE, pid));
      if (!target.value) {
        const auto error = GetLastError();
        if (queryExited(query.value)) continue;
        report(L"terminate-open-failed", pid, error, path.c_str());
        result = failed;
        continue;
      }
      if (queryExited(query.value) || exited(target.value)) continue;
      FILETIME original, current;
      if (!creationTime(query.value, original) || !creationTime(target.value, current) ||
          CompareFileTime(&original, &current) != 0 ||
          !samePath(canonicalPath(imagePath(target.value)), executable.path)) {
        if (queryExited(query.value)) continue;
        report(L"identity-changed", pid, 0, path.c_str());
        result = failed;
        continue;
      }
      if (!TerminateProcess(target.value, 0)) {
        const auto error = GetLastError();
        if (exited(target.value)) continue;
        report(L"terminate-failed", pid, error, path.c_str());
        result = failed;
        continue;
      }
      const auto wait = WaitForSingleObject(target.value, 3000);
      if (wait == WAIT_OBJECT_0) {
        report(L"exited", pid, 0, path.c_str());
      } else {
        report(L"wait-failed", pid, wait == WAIT_FAILED ? GetLastError() : wait, path.c_str());
        result = failed;
      }
    }
  } while (Process32NextW(snapshot.value, &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES) {
    report(L"enumerate-failed", 0, GetLastError());
    return failed;
  }
  return result;
}

void listLockOwners(std::vector<const wchar_t*> files) {
  if (files.empty()) return;
  DWORD session = 0;
  wchar_t key[CCH_RM_SESSION_KEY + 1]{};
  DWORD error = RmStartSession(&session, 0, key);
  if (error != ERROR_SUCCESS) {
    report(L"restart-manager-start-failed", 0, error);
    return;
  }
  error = RmRegisterResources(session, static_cast<UINT>(files.size()), files.data(),
    0, nullptr, 0, nullptr);
  std::vector<RM_PROCESS_INFO> owners;
  UINT needed = 0, count = 0;
  DWORD reboot = 0;
  if (error == ERROR_SUCCESS) {
    for (int attempt = 0; attempt < 4; ++attempt) {
      count = static_cast<UINT>(owners.size());
      error = RmGetList(session, &needed, &count, owners.data(), &reboot);
      if (error != ERROR_MORE_DATA) break;
      owners.resize(needed);
    }
  }
  RmEndSession(session);
  if (error != ERROR_SUCCESS) {
    report(L"restart-manager-query-failed", 0, error);
    return;
  }
  if (count == 0) report(L"restart-manager-no-owner-reported", 0);
  for (UINT index = 0; index < count; ++index) {
    const auto& owner = owners[index];
    report(L"restart-manager-owner", owner.Process.dwProcessId, 0, owner.strAppName);
  }
}

bool existingFile(const std::wstring& path) {
  const auto attrs = GetFileAttributesW(path.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  std::setlocale(LC_CTYPE, ".ACP");
  if (argc >= 4 && std::wstring(argv[1]) == L"--log") {
    diagnosticLog = argv[2];
    argc -= 2;
    argv += 2;
  }
  if (argc < 3) return failed;
  const std::wstring mode = argv[1];
  if (mode == L"owners" && argc == 3) {
    report(L"restart-manager-file", 0, 0, argv[2]);
    listLockOwners({argv[2]});
    return 0;
  }
  if (argc != 4) return failed;
  const std::wstring root = canonicalPath(argv[2]);
  const std::wstring main = argv[3];
  if (main.empty() || main.find_first_of(L"\\/:*?") != std::wstring::npos) return failed;
  if (root.empty()) {
    const auto error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return 0;
    report(L"installation-path-failed", 0, error, argv[2]);
    return failed;
  }
  if (mode == L"legacy-owners") {
    report(L"restart-manager-legacy-sample", 0, 0, argv[2]);
    const std::wstring directory = argv[2];
    std::vector<std::wstring> paths = {directory + L"\\" + main,
      directory + L"\\resources\\app.asar"};
    for (const auto* executable : bundledExecutables) {
      paths.push_back(directory + L"\\" + executable);
    }
    std::vector<const wchar_t*> files;
    for (const auto& path : paths) {
      if (existingFile(path)) {
        report(L"restart-manager-sampled-file", 0, 0, path.c_str());
        files.push_back(path.c_str());
      }
    }
    listLockOwners(files);
    return 0;
  }

  std::vector<Executable> executables;
  if (!addExecutable(executables, root, main, true)) return failed;
  // These are the executable paths shipped by OhMyGame. A custom installation
  // directory may also contain unrelated software or user-provided scripts.
  if (existingFile(root + L"\\resources\\app.asar") || !executables.empty()) {
    for (const auto* executable : bundledExecutables) {
      if (!addExecutable(executables, root, executable, false)) return failed;
    }
  }
  if (mode == L"probe") return scan(executables, Action::probe);
  if (mode == L"close") return scan(executables, Action::close);
  if (mode != L"clean" && mode != L"force") return failed;
  if (mode == L"clean") {
    const auto before = scan(executables, Action::probe);
    if (before != runtimeRunning) return before;
  }
  const auto result = scan(executables, mode == L"clean" ? Action::clean : Action::force);
  const auto remaining = scan(executables, Action::probe);
  return result == failed ? failed : remaining;
}
