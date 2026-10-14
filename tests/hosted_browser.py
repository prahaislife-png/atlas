"""Browser Auth/organization UX against a local, explicitly fake Auth service.
Real Postgres RLS is separately tested by npm run test:db; this is not live Auth proof.
"""
import os, shutil, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parents[1]
server=subprocess.Popen(['node','tests/hosted-browser-server.js'],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    base=server.stdout.readline().strip()
    assert base.startswith('http://localhost:'), 'Fixture server did not start'
    with sync_playwright() as p:
        executable=os.environ.get('ATLAS_TEST_CHROMIUM') or shutil.which('chromium') or shutil.which('google-chrome')
        browser=p.chromium.launch(headless=True,executable_path=executable,args=['--no-sandbox'])
        errors=[]
        def login(page,email):
            page.goto(base)
            expect(page.locator('#accountEmail')).to_be_visible()
            page.locator('#accountEmail').fill(email)
            page.locator('#accountPassword').fill('fixture-password')
            page.locator('#accountSubmit').click()
        context=browser.new_context()
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        login(page,'a@example.com')
        expect(page.locator('#organizationPicker')).to_be_visible()
        expect(page.locator('#organizationPicker')).to_have_value('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        expect(page.locator('#side-brand')).to_have_text('Research Business')
        assert 'Private B Business' not in page.locator('body').inner_text()
        cookies=context.cookies()
        access=next(c for c in cookies if c['name']=='__Host-atlas-access')
        assert access['httpOnly'] and access['secure'] and access['sameSite']=='Lax'
        assert page.evaluate('Object.keys(localStorage).length')==0
        page.locator('#researchHistory').click()
        expect(page.locator('dialog')).to_contain_text('No archived research versions yet')
        page.get_by_role('button',name='Close history').click()
        page.locator('#signOut').click()
        expect(page.locator('#accountEmail')).to_be_visible()
        assert 'Research Business' not in page.locator('#view').inner_text()
        context.close()

        context=browser.new_context(viewport={'width':390,'height':844})
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        login(page,'new@example.com')
        expect(page.locator('#organizationName')).to_be_visible()
        page.locator('#organizationName').fill('Our Beauty Team')
        page.locator('#accountSubmit').click()
        expect(page.locator('#onboardingForm')).to_be_visible()
        expect(page.locator('#brand')).to_have_value('')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile account flow overflows'
        context.close()

        context=browser.new_context()
        page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        login(page,'viewer@example.com')
        expect(page.locator('#organizationPicker')).to_be_visible()
        expect(page.locator('#scanBtn')).to_be_disabled()
        page.locator('[data-view="actions"]').click()
        expect(page.locator('#addAction')).to_be_disabled()
        page.locator('[data-view="settings"]').click()
        expect(page.locator('h1')).to_contain_text('inspect')
        context.close()
        browser.close()
        assert not errors, errors
        print('PASS hosted browser: verified-account login UX, secure cookies, no browser token storage, tenant context, organization creation, sign-out, read-only role and mobile flow. Auth responses were TEST FIXTURES.')
finally:
    server.terminate()
    try: server.wait(timeout=10)
    except subprocess.TimeoutExpired: server.kill();server.wait()
