@echo off
REM Builds RealtorAgentScraper.exe on Windows. Requires Python 3.10+ installed.
pip install -r requirements.txt pyinstaller
pyinstaller --onefile --noconsole --name RealtorAgentScraper --collect-all selenium realtor_agent_scraper.py
echo.
echo Done! Your exe is in the dist\ folder: dist\RealtorAgentScraper.exe
pause
