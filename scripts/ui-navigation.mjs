// Follow the same visible navigation as a user. Desktop conversations live in
// the directory; the compact selector is reserved for narrow screens.
export async function returnToConversation(page) {
  const standalone = page.locator('.auxiliary-page:visible');
  if (await standalone.count()) {
    await standalone.locator('[data-close], #close-counterpart-dialog').first().click();
  } else if (await page.locator('#counterpart-dialog').isVisible()) {
    await page.locator('#close-counterpart-dialog').click();
  }
}

export async function switchConversation(page, id) {
  await returnToConversation(page);
  const row = page.locator(`#counterpart-list button[data-counterpart-id="${id}"]`);
  if (await row.isVisible()) await row.click();
  else await page.locator('#counterpart-select').selectOption(id);
}

export async function openNewConversation(page) {
  await returnToConversation(page);
  const directoryAdd = page.locator('#directory-add');
  await (await directoryAdd.isVisible() ? directoryAdd : page.locator('#add-counterpart')).click();
}

export async function openCoachPlan(page) {
  const details = page.locator('#field-coach-plan-details');
  if (await details.count() && await details.getAttribute('open') === null) await details.locator('summary').first().click();
}
