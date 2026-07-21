@echo off
REM Builds RealtorAgentScraper.exe on Windows. Requires Python 3.10+ installed.
pip install -r requirements.txt pyinstaller
pyinstaller --onedir --noconsole --name RealtorAgentScraper --collect-all selenium realtor_agent_scraper.py
echo.
echo Done! Your app folder is: dist\RealtorAgentScraper\
echo Run dist\RealtorAgentScraper\RealtorAgentScraper.exe
pause
